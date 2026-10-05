#!/usr/bin/env node
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
import {
  detectAgents,
  findOnPath,
  installContext,
  installLauncher,
  uninstallLauncher,
  installService,
  registerAgents,
  stableCliPath,
  uninstallService,
  unregisterAgents
} from "./install.mjs";
import { createLlmAdapterManager } from "./llm-adapters.mjs";
import {
  createMcpClientManager,
  DEFAULT_MCP_SERVERS_FILE
} from "./mcp-client.mjs";

const THIS_FILE = fileURLToPath(import.meta.url);
// Set by the single-file build (scripts/build-bridge.mjs).
const BUNDLED = typeof __BROWSERHARNESS_BUNDLED__ !== "undefined";
const USER_HOME = os.homedir();
const HOME = path.join(USER_HOME, ".browserharness-bridge");
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

async function start(config, created, cliPath = THIS_FILE, { quiet = false } = {}) {
  const current = await readStatus(config);
  if (current.running) {
    if (quiet) return;
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
    [cliPath, "serve"],
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

  if (quiet) return;
  print({
    ...status,
    ws: wsBase(config),
    config: CONFIG_FILE,
    ...(created
      ? {
          pairing_token: config.token,
          note:
            "Next: press Pair in BrowserHarness (Settings → Coding agents), then run: browserharness-bridge pair"
        }
      : {})
  });
}

async function stop(config, { quiet = false } = {}) {
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
  if (!quiet) print(status);
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


function flag(name) {
  return process.argv.includes(`--${name}`);
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function bridgeRequest(config, pathname, body) {
  const response = await fetch(`${httpBase(config)}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.token}`
    },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(5000)
  });
  return response.json();
}

/** `skills` lists the person's Skills; `skill <name> [details]` prints one, ready to follow. */
async function skillsCommand(config, name, details) {
  const result = await bridgeRequest(config, "/command", {
    session: "cli",
    title: "Skills",
    action: "skills",
    args: name ? { name, details } : {}
  }).catch(() => ({
    ok: false,
    error: { message: "The bridge is not running. Start it with: browserharness-bridge start" }
  }));
  if (!result?.ok) throw new Error(result?.error?.message || "Couldn't read Skills from Chrome");
  if (name) {
    process.stdout.write(`${result.data.instructions}\n`);
  } else if (flag("json")) {
    print(result.data);
  } else if (!result.data.skills.length) {
    process.stdout.write("No Skills yet. Save one from the BrowserHarness side panel (Save as Skill).\n");
  } else {
    for (const skill of result.data.skills) {
      process.stdout.write(`${skill.name.padEnd(28)} ${skill.title}\n`);
    }
  }
}

async function waitForExtension(config, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await readStatus(config, 800);
    if (status.extension_connected) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function askLine(question) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

const PAIR_HELP =
  "In Chrome, open BrowserHarness → Settings → Coding agents and press Pair. It shows a 6-digit code.";

// How to run this program again from a terminal.
function commandHint(cliPath = THIS_FILE) {
  return findOnPath("browserharness-bridge")
    ? "browserharness-bridge"
    : `node "${cliPath}"`;
}

/**
 * Approve the extension's pairing request by its code. With --code it runs
 * without questions; in a terminal it asks for the code.
 */
async function pair(config, { code, interactive, json }) {
  const status = await readStatus(config);
  if (!status.running) {
    throw new Error(`The Bridge is not running. Run: ${commandHint()} install`);
  }
  let attempts = interactive ? 3 : 1;
  let entered = code;
  if (!entered && interactive) print(PAIR_HELP);
  while (attempts > 0) {
    attempts -= 1;
    if (!entered && interactive) {
      entered = await askLine("Type the code here (or press Enter to skip): ");
      if (!entered) {
        print(`Skipped. Pair later with: ${commandHint()} pair`);
        return { paired: false };
      }
    }
    if (!entered) {
      throw new Error(`${PAIR_HELP} Then run: ${commandHint()} pair --code <code>`);
    }
    const result = await bridgeRequest(config, "/pair/approve", { code: entered });
    if (result.ok) {
      const connected = await waitForExtension(config, 15_000);
      const outcome = { paired: true, extension_connected: connected };
      if (json) print(outcome);
      else
        print(
          connected
            ? "Paired. BrowserHarness in Chrome is connected."
            : "Approved. BrowserHarness will connect in a few seconds."
        );
      return outcome;
    }
    print(result.error?.message || "That code did not match.");
    entered = undefined;
  }
  throw new Error(`Pairing was not completed. Run ${commandHint()} pair to try again.`);
}

function context(cliPath) {
  return installContext({ home: USER_HOME, cliPath });
}

async function install(config, created) {
  const json = flag("json");
  const say = (line) => {
    if (!json) print(line);
  };
  const cliPath = await stableCliPath({ cliPath: THIS_FILE, home: USER_HOME, bundled: BUNDLED });
  const ctx = context(cliPath);

  say("Installing BrowserHarness Bridge…");
  await mkdir(LOG_DIR, { recursive: true });
  const launcher = await installLauncher(ctx);
  if ((await readStatus(config)).running) {
    await stop(config, { quiet: true });
  }

  let service = { kind: "none", running: false };
  if (!flag("no-service")) {
    service = await installService(ctx);
  }
  if (!service.running) {
    await start(config, false, cliPath, { quiet: true });
  }
  const status = await waitForState(config, true, 8000);
  if (!status.running) {
    throw new Error(`BrowserHarness Bridge did not start. Check ${LOG_FILE}`);
  }
  say(
    service.kind !== "none" && (service.running || service.kind === "startup-folder")
      ? "✓ Bridge is running and starts when you log in."
      : `✓ Bridge is running.${service.note ? ` ${service.note}` : ""}`
  );

  let agents = [];
  if (!flag("no-agents")) {
    const only = option("agents")?.split(",").map((value) => value.trim()).filter(Boolean);
    agents = await registerAgents(ctx, { only });
    for (const agent of agents) {
      if (agent.status === "connected") say(`✓ ${agent.name}: connected (ask it to use BrowserHarness, or type /browserharness)`);
      else if (agent.status === "failed") say(`✗ ${agent.name}: ${agent.error}`);
    }
    if (!agents.some((agent) => agent.status === "connected")) {
      say("No coding agents found (Claude Code, Codex, Cursor, Hermes). Install one, then run this again.");
    }
  }

  const summary = {
    installed: true,
    cli: cliPath,
    launcher,
    service: { kind: service.kind, file: service.file, starts_at_login: service.kind !== "none" && (service.running || service.kind === "startup-folder") },
    agents,
    extension_connected: Boolean(status.extension_connected)
  };
  if (json) print(summary);

  if (status.extension_connected) {
    say("✓ BrowserHarness in Chrome is already connected. You're ready.");
  } else if (!flag("no-pair") && process.stdin.isTTY) {
    await pair(config, { interactive: true });
  } else if (!json) {
    say(`Last step: ${PAIR_HELP} Then run: ${launcher ? "browserharness-bridge" : `node "${cliPath}"`} pair`);
  }
  return summary;
}

async function uninstall(config) {
  const cliPath = BUNDLED
    ? path.join(HOME, "bin", "browserharness-bridge.mjs")
    : THIS_FILE;
  const ctx = context(cliPath);
  const agents = await unregisterAgents(ctx);
  await uninstallLauncher(ctx);
  const service = await uninstallService(ctx);
  if ((await readStatus(config)).running) {
    await stop(config, { quiet: true }).catch(() => undefined);
  }
  await rm(path.join(HOME, "bin"), { recursive: true, force: true });
  if (flag("purge")) await rm(HOME, { recursive: true, force: true });
  print({ uninstalled: true, service: service.file, agents, purged: flag("purge") });
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
  } else if (command === "install") {
    await install(config, created);
  } else if (command === "uninstall") {
    await uninstall(config);
  } else if (command === "agents") {
    print({ agents: detectAgents(context(THIS_FILE)) });
  } else if (command === "skills") {
    await skillsCommand(config);
  } else if (command === "skill") {
    const name = process.argv[3];
    if (!name) throw new Error("Usage: browserharness-bridge skill <name> [details]");
    await skillsCommand(config, name, process.argv.slice(4).join(" "));
  } else if (command === "pair") {
    if (flag("show-token")) {
      print({
        ws: wsBase(config),
        pairing_token: config.token,
        config: CONFIG_FILE
      });
    } else {
      await pair(config, {
        code: option("code"),
        interactive: process.stdin.isTTY && !option("code"),
        json: flag("json")
      });
    }
  } else {
    throw new Error(
      "Usage: browserharness-bridge [install|uninstall|pair|agents|skills|skill <name>|start|status|stop|restart|logs|remote|mcp|mcp-servers]"
    );
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}
