import crypto from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  open,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBridgeServer,
  isLoopbackHost,
  REMOTE_MIN_TOKEN_LENGTH
} from "./core.mjs";
import { serveBrowserHarnessMcp } from "./mcp.mjs";
import { createLlmAdapterManager } from "./llm-adapters.mjs";
import {
  createMcpClientManager,
  DEFAULT_MCP_SERVERS_FILE
} from "./mcp-client.mjs";

const THIS_FILE = fileURLToPath(import.meta.url);
const HOME = path.join(os.homedir(), ".browserharness-bridge");
const CONFIG_FILE = path.join(HOME, "config.json");
const PID_FILE = path.join(HOME, "daemon.pid");
const ADDR_FILE = path.join(HOME, "daemon.addr");
const LOG_DIR = path.join(HOME, "logs");
const LOG_FILE = path.join(LOG_DIR, "daemon.log");

function print(value) {
  process.stdout.write(
    typeof value === "string"
      ? `${value}\n`
      : `${JSON.stringify(value)}\n`
  );
}

async function ensureConfig() {
  await mkdir(HOME, { recursive: true });
  try {
    const config = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
    return { config, created: false };
  } catch {
    const config = {
      host: "127.0.0.1",
      port: 10087,
      allow_remote: false,
      token: crypto.randomBytes(24).toString("hex")
    };
    await writeFile(
      CONFIG_FILE,
      JSON.stringify(config, null, 2) + "\n",
      { mode: 0o600 }
    );
    return { config, created: true };
  }
}

// Address used to reach the daemon from this machine. A wildcard bind
// (0.0.0.0 / ::) is not dialable, so map it to loopback.
function localHost(config) {
  if (config.host === "0.0.0.0") return "127.0.0.1";
  if (config.host === "::") return "::1";
  return config.host;
}

function httpBase(config) {
  const host = localHost(config);
  return `http://${host.includes(":") ? `[${host}]` : host}:${config.port}`;
}

function wsBase(config) {
  const host = localHost(config);
  return `ws://${host.includes(":") ? `[${host}]` : host}:${config.port}/ws`;
}

async function readStatus(config, timeoutMs = 900) {
  try {
    const response = await fetch(`${httpBase(config)}/status`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await response.json();
    if (!response.ok || body?.running !== true) {
      throw new Error("Not BrowserHarness Bridge");
    }
    return body;
  } catch {
    return {
      running: false,
      addr: `${config.host}:${config.port}`
    };
  }
}

async function waitForState(config, expectedRunning, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await readStatus(config, 500);
    if (Boolean(status.running) === expectedRunning) return status;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return readStatus(config, 500);
}

async function serve(config) {
  await mkdir(LOG_DIR, { recursive: true });
  const mcpManager = createMcpClientManager();
  const bridge = createBridgeServer({
    host: config.host,
    port: config.port,
    token: config.token,
    allowRemote: config.allow_remote === true,
    llmManager: createLlmAdapterManager(),
    mcpManager
  });
  const address = await bridge.listen();

  await writeFile(PID_FILE, `${process.pid}\n`);
  await writeFile(
    ADDR_FILE,
    `${config.host}:${address.port}\n`
  );

  print({
    running: true,
    pid: process.pid,
    addr: `${config.host}:${address.port}`,
    ws: wsBase(config)
  });

  const shutdown = async () => {
    await bridge.close().catch(() => undefined);
    await Promise.all([
      rm(PID_FILE, { force: true }),
      rm(ADDR_FILE, { force: true })
    ]);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

async function start(config, created) {
  const current = await readStatus(config);
  if (current.running) {
    print({
      ...current,
      ws: wsBase(config),
      note: "BrowserHarness Bridge is already running"
    });
    return;
  }

  await mkdir(LOG_DIR, { recursive: true });
  const log = await open(LOG_FILE, "a");

  const child = spawn(
    process.execPath,
    [THIS_FILE, "serve"],
    {
      detached: true,
      stdio: ["ignore", log.fd, log.fd]
    }
  );
  child.unref();
  await log.close();

  const status = await waitForState(config, true);
  if (!status.running) {
    throw new Error(
      `BrowserHarness Bridge did not start. Check ${LOG_FILE}`
    );
  }

  print({
    ...status,
    ws: wsBase(config),
    config: CONFIG_FILE,
    ...(created
      ? {
          pairing_token: config.token,
          note:
            "Pairing token created. Paste it into BrowserHarness Settings → Local Agent Bridge."
        }
      : {})
  });
}

async function stop(config) {
  const current = await readStatus(config);
  if (!current.running) {
    await Promise.all([
      rm(PID_FILE, { force: true }),
      rm(ADDR_FILE, { force: true })
    ]);
    print({
      running: false,
      addr: `${config.host}:${config.port}`
    });
    return;
  }

  let pid;
  try {
    pid = Number((await readFile(PID_FILE, "utf8")).trim());
  } catch {
    throw new Error(
      `Bridge is running but ${PID_FILE} is missing; stop that process manually.`
    );
  }

  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("Invalid BrowserHarness Bridge PID file");
  }

  process.kill(pid, "SIGTERM");
  const status = await waitForState(config, false);

  if (status.running) {
    throw new Error(
      "BrowserHarness Bridge did not stop within the expected window"
    );
  }

  await Promise.all([
    rm(PID_FILE, { force: true }),
    rm(ADDR_FILE, { force: true })
  ]);
  print(status);
}

async function listMcpServers() {
  const manager = createMcpClientManager();
  try {
    print({
      config: DEFAULT_MCP_SERVERS_FILE,
      servers: await manager.listServers()
    });
  } finally {
    await manager.closeAll();
  }
}

async function setRemote(config, args) {
  const mode = args[0];
  if (mode === "on") {
    const host = args[1] || "0.0.0.0";
    if (isLoopbackHost(host)) {
      throw new Error("remote on needs a non-loopback bind host, e.g. 0.0.0.0");
    }
    const next = {
      ...config,
      host,
      allow_remote: true,
      token:
        config.token.length >= REMOTE_MIN_TOKEN_LENGTH
          ? config.token
          : crypto.randomBytes(24).toString("hex")
    };
    await writeFile(CONFIG_FILE, JSON.stringify(next, null, 2) + "\n", {
      mode: 0o600
    });
    print({
      remote: true,
      host,
      port: next.port,
      token_rotated: next.token !== config.token,
      note:
        "Restart the Bridge to apply. The Bridge speaks plain ws:// on its port: put it behind a TLS reverse proxy and give the extension the wss:// address. Anyone holding the pairing token can drive the paired browser."
    });
  } else if (mode === "off") {
    const next = { ...config, host: "127.0.0.1", allow_remote: false };
    await writeFile(CONFIG_FILE, JSON.stringify(next, null, 2) + "\n", {
      mode: 0o600
    });
    print({ remote: false, host: "127.0.0.1", note: "Restart the Bridge to apply." });
  } else {
    print({
      remote: config.allow_remote === true && !isLoopbackHost(config.host),
      host: config.host,
      port: config.port
    });
  }
}

async function logs() {
  const nIndex = process.argv.indexOf("-n");
  const requested =
    nIndex >= 0 ? Number(process.argv[nIndex + 1]) : 80;
  const count =
    Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), 5000)
      : 80;

  try {
    const text = await readFile(LOG_FILE, "utf8");
    print(text.split(/\r?\n/).slice(-count).join("\n"));
  } catch {
    print(`No bridge log exists yet at ${LOG_FILE}`);
  }
}

const command = process.argv[2] || "start";
const { config, created } = await ensureConfig();

try {
  if (command === "serve") {
    await serve(config);
  } else if (command === "mcp") {
    await serveBrowserHarnessMcp({ ...config, host: localHost(config) });
  } else if (command === "start") {
    await start(config, created);
  } else if (command === "status") {
    print(await readStatus(config));
  } else if (command === "stop") {
    await stop(config);
  } else if (command === "restart") {
    await stop(config);
    await start(config, false);
  } else if (command === "logs") {
    await logs();
  } else if (command === "mcp-servers") {
    await listMcpServers();
  } else if (command === "remote") {
    await setRemote(config, process.argv.slice(3));
  } else if (command === "pair") {
    print({
      ws: wsBase(config),
      pairing_token: config.token,
      config: CONFIG_FILE
    });
  } else {
    throw new Error(
      "Usage: browserharness-bridge [start|status|stop|restart|logs|pair|remote|mcp|mcp-servers]"
    );
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}
