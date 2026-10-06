import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { SKILL_MARKER, SKILL_MD } from "./skill.mjs";

export const SERVER_NAME = "browserharness";
const MANAGED = "managed by browserharness-bridge";
const BLOCK_START = `# >>> ${SERVER_NAME} (${MANAGED}) >>>`;
const BLOCK_END = `# <<< ${SERVER_NAME} <<<`;

/**
 * Everything the installer touches on this computer, injectable so tests can
 * run against a temporary home folder with fake agents.
 */
export function installContext({
  home,
  platform = process.platform,
  env = process.env,
  nodePath = process.execPath,
  cliPath,
  run = runCommand,
  which = findOnPath
}) {
  return { home, platform, env, nodePath, cliPath, run, which };
}

export function runCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 30_000,
    shell: false
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || (result.error ? String(result.error.message) : "")
  };
}

export function findOnPath(command, env = process.env, platform = process.platform) {
  const extensions = platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, command + extension);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function mcpCommand(ctx) {
  return { command: ctx.nodePath, args: [ctx.cliPath, "mcp"] };
}

async function readText(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** Keep one copy of a config file as it was before we first changed it. */
async function backupOnce(file, text) {
  const backup = `${file}.before-browserharness`;
  if (text !== null && !existsSync(backup)) {
    await writeFile(backup, text);
  }
}

async function writeTextFile(file, text, mode) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, mode ? { mode } : undefined);
}

// ---------- JSON configs (Claude Code, Cursor) ----------

async function editJsonServers(file, entry) {
  const text = await readText(file);
  let data = {};
  if (text !== null && text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${file} is not valid JSON, so it was left unchanged`);
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${file} has an unexpected shape, so it was left unchanged`);
  }
  const servers =
    data.mcpServers && typeof data.mcpServers === "object" ? { ...data.mcpServers } : {};
  if (entry) {
    servers[SERVER_NAME] = entry;
  } else if (SERVER_NAME in servers) {
    delete servers[SERVER_NAME];
  } else {
    return false;
  }
  await backupOnce(file, text);
  await writeTextFile(file, `${JSON.stringify({ ...data, mcpServers: servers }, null, 2)}\n`);
  return true;
}

// ---------- marker blocks (Codex TOML, Hermes YAML) ----------

export function removeManagedBlock(text) {
  const lines = text.split("\n");
  const out = [];
  let inside = false;
  for (const line of lines) {
    if (line.trim() === BLOCK_START) {
      inside = true;
      continue;
    }
    if (inside && line.trim() === BLOCK_END) {
      inside = false;
      continue;
    }
    if (!inside) out.push(line);
  }
  return out.join("\n");
}

export function codexBlock(ctx) {
  const { command, args } = mcpCommand(ctx);
  return [
    BLOCK_START,
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${JSON.stringify(command)}`,
    `args = [${args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 120",
    BLOCK_END
  ].join("\n");
}

export function withCodexServer(text, ctx) {
  const base = removeManagedBlock(text || "");
  if (new RegExp(`^\\s*\\[mcp_servers\\.${SERVER_NAME}\\]`, "m").test(base)) {
    return { text: base, skipped: "already has a browserharness server you added yourself" };
  }
  const trimmed = base.replace(/\s+$/, "");
  return { text: `${trimmed ? `${trimmed}\n\n` : ""}${codexBlock(ctx)}\n` };
}

export function withHermesServer(text, ctx) {
  const { command, args } = mcpCommand(ctx);
  const base = removeManagedBlock(text || "");
  const entry = (indent) =>
    [
      `${indent}${SERVER_NAME}:`,
      `${indent}  command: ${JSON.stringify(command)}`,
      `${indent}  args: [${args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
      `${indent}  timeout: 120`
    ];
  const lines = base.split("\n");
  const keyIndex = lines.findIndex((line) => /^mcp_servers:\s*(\{\s*\})?\s*(#.*)?$/.test(line));
  if (keyIndex >= 0) {
    // Insert our entry under the existing top-level key.
    const following = lines.slice(keyIndex + 1);
    const childIndent = following.find((line) => /^\s+\S/.test(line) && !/^\s*#/.test(line));
    if (
      following.some((line) => new RegExp(`^\\s+${SERVER_NAME}:`).test(line)) &&
      !/\{\s*\}/.test(lines[keyIndex])
    ) {
      return { text: base, skipped: "already has a browserharness server you added yourself" };
    }
    const indent = childIndent ? childIndent.match(/^\s+/)[0] : "  ";
    lines[keyIndex] = "mcp_servers:";
    lines.splice(keyIndex + 1, 0, `${indent}${BLOCK_START}`, ...entry(indent), `${indent}${BLOCK_END}`);
    return { text: lines.join("\n") };
  }
  if (/^mcp_servers:/m.test(base)) {
    return { text: base, skipped: "mcp_servers is written in a form the installer does not edit" };
  }
  const trimmed = base.replace(/\s+$/, "");
  return {
    text: `${trimmed ? `${trimmed}\n\n` : ""}${[BLOCK_START, "mcp_servers:", ...entry("  "), BLOCK_END].join("\n")}\n`
  };
}

async function editBlockFile(file, edit) {
  const text = await readText(file);
  const next = edit(text);
  if (next.skipped) return { changed: false, note: next.skipped };
  if (next.text === (text ?? "")) return { changed: false };
  await backupOnce(file, text);
  await writeTextFile(file, next.text);
  return { changed: true };
}

async function removeBlockFile(file) {
  const text = await readText(file);
  if (text === null) return false;
  const removed = removeManagedBlock(text);
  if (removed === text) return false;
  const next = removed.trim() ? `${removed.replace(/\s+$/, "")}\n` : "";
  await writeTextFile(file, next);
  return true;
}

// ---------- skill files ----------

async function writeSkill(dir) {
  const file = path.join(dir, SERVER_NAME, "SKILL.md");
  const current = await readText(file);
  if (current !== null && !current.includes(SKILL_MARKER)) {
    return { file, note: "kept your own browserharness skill file" };
  }
  await writeTextFile(file, SKILL_MD);
  return { file };
}

async function removeSkill(dir) {
  const folder = path.join(dir, SERVER_NAME);
  const current = await readText(path.join(folder, "SKILL.md"));
  if (current === null || !current.includes(SKILL_MARKER)) return false;
  await rm(folder, { recursive: true, force: true });
  return true;
}

// ---------- agents ----------

function hermesHome(ctx) {
  if (ctx.platform === "win32" && ctx.env.LOCALAPPDATA) {
    return path.join(ctx.env.LOCALAPPDATA, "hermes");
  }
  return path.join(ctx.home, ".hermes");
}

export const AGENTS = [
  {
    id: "claude",
    name: "Claude Code",
    detect: (ctx) => existsSync(path.join(ctx.home, ".claude")) || Boolean(ctx.which("claude")),
    skillDirs: (ctx) => [path.join(ctx.home, ".claude", "skills")],
    async register(ctx) {
      const { command, args } = mcpCommand(ctx);
      const cli = ctx.which("claude");
      if (cli) {
        ctx.run(cli, ["mcp", "remove", SERVER_NAME, "--scope", "user"]);
        const added = ctx.run(cli, ["mcp", "add", "--scope", "user", SERVER_NAME, "--", command, ...args]);
        if (added.code === 0) return `claude mcp add (user scope)`;
      }
      const file = path.join(ctx.home, ".claude.json");
      await editJsonServers(file, { type: "stdio", command, args, env: {} });
      return file;
    },
    async unregister(ctx) {
      const cli = ctx.which("claude");
      if (cli) ctx.run(cli, ["mcp", "remove", SERVER_NAME, "--scope", "user"]);
      const file = path.join(ctx.home, ".claude.json");
      if (existsSync(file)) await editJsonServers(file, null);
    }
  },
  {
    id: "codex",
    name: "Codex",
    detect: (ctx) => existsSync(path.join(ctx.home, ".codex")) || Boolean(ctx.which("codex")),
    skillDirs: (ctx) => [path.join(ctx.home, ".agents", "skills")],
    async register(ctx) {
      const file = path.join(ctx.home, ".codex", "config.toml");
      const result = await editBlockFile(file, (text) => withCodexServer(text, ctx));
      if (result.note) throw new Error(`${file} ${result.note}`);
      return file;
    },
    async unregister(ctx) {
      await removeBlockFile(path.join(ctx.home, ".codex", "config.toml"));
    }
  },
  {
    id: "cursor",
    name: "Cursor",
    detect: (ctx) => existsSync(path.join(ctx.home, ".cursor")),
    // Cursor also reads ~/.claude/skills and ~/.agents/skills, so it only
    // needs its own copy when neither of those agents got one.
    skillDirs: (ctx, installed) =>
      installed.has("claude") || installed.has("codex")
        ? []
        : [path.join(ctx.home, ".cursor", "skills")],
    async register(ctx) {
      const { command, args } = mcpCommand(ctx);
      const file = path.join(ctx.home, ".cursor", "mcp.json");
      await editJsonServers(file, { type: "stdio", command, args });
      return file;
    },
    async unregister(ctx) {
      const file = path.join(ctx.home, ".cursor", "mcp.json");
      if (existsSync(file)) await editJsonServers(file, null);
    }
  },
  {
    id: "hermes",
    name: "Hermes",
    detect: (ctx) => existsSync(hermesHome(ctx)) || Boolean(ctx.which("hermes")),
    skillDirs: (ctx) => [path.join(hermesHome(ctx), "skills")],
    async register(ctx) {
      const file = path.join(hermesHome(ctx), "config.yaml");
      const result = await editBlockFile(file, (text) => withHermesServer(text, ctx));
      if (result.note) throw new Error(`${file} ${result.note}`);
      return file;
    },
    async unregister(ctx) {
      await removeBlockFile(path.join(hermesHome(ctx), "config.yaml"));
    }
  }
];

const ALL_SKILL_DIRS = (ctx) => [
  path.join(ctx.home, ".claude", "skills"),
  path.join(ctx.home, ".agents", "skills"),
  path.join(ctx.home, ".cursor", "skills"),
  path.join(hermesHome(ctx), "skills")
];

export function detectAgents(ctx) {
  return AGENTS.map((agent) => ({
    id: agent.id,
    name: agent.name,
    found: agent.detect(ctx)
  }));
}

/** Register the MCP server and skill in every agent found (or `only`). */
export async function registerAgents(ctx, { only } = {}) {
  const results = [];
  const installed = new Set();
  for (const agent of AGENTS) {
    const wanted = only ? only.includes(agent.id) : agent.detect(ctx);
    if (!wanted) {
      results.push({ id: agent.id, name: agent.name, status: "not found" });
      continue;
    }
    try {
      const where = await agent.register(ctx);
      const skills = [];
      for (const dir of agent.skillDirs(ctx, installed)) {
        skills.push((await writeSkill(dir)).file);
      }
      installed.add(agent.id);
      results.push({ id: agent.id, name: agent.name, status: "connected", config: where, skills });
    } catch (error) {
      results.push({
        id: agent.id,
        name: agent.name,
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return results;
}

export async function unregisterAgents(ctx) {
  const results = [];
  for (const agent of AGENTS) {
    try {
      await agent.unregister(ctx);
      results.push({ id: agent.id, status: "removed" });
    } catch (error) {
      results.push({ id: agent.id, status: "failed", error: String(error?.message || error) });
    }
  }
  for (const dir of ALL_SKILL_DIRS(ctx)) await removeSkill(dir);
  return results;
}

// ---------- login service ----------

const SERVICE_LABEL = "com.browserharness.bridge";

function xmlEscape(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The file that starts the Bridge at login on this platform. */
export function serviceDefinition(ctx) {
  const pathEnv = ctx.env.PATH || "";
  if (ctx.platform === "darwin") {
    const file = path.join(ctx.home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
    const log = path.join(ctx.home, ".browserharness-bridge", "logs", "daemon.log");
    return {
      kind: "launchd",
      file,
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(ctx.nodePath)}</string>
    <string>${xmlEscape(ctx.cliPath)}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xmlEscape(pathEnv)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(log)}</string>
</dict>
</plist>
`
    };
  }
  if (ctx.platform === "win32") {
    const startup = path.join(
      ctx.env.APPDATA || path.join(ctx.home, "AppData", "Roaming"),
      "Microsoft", "Windows", "Start Menu", "Programs", "Startup"
    );
    const quoted = (value) => `""${value}""`;
    return {
      kind: "startup-folder",
      file: path.join(startup, "BrowserHarness Bridge.vbs"),
      content: `' ${MANAGED}\r\nCreateObject("WScript.Shell").Run "${quoted(ctx.nodePath)} ${quoted(ctx.cliPath)} serve", 0, False\r\n`
    };
  }
  const quote = (value) => `"${String(value).replace(/(["\\])/g, "\\$1")}"`;
  return {
    kind: "systemd",
    file: path.join(ctx.env.XDG_CONFIG_HOME || path.join(ctx.home, ".config"), "systemd", "user", "browserharness-bridge.service"),
    content: `# ${MANAGED}
[Unit]
Description=BrowserHarness Bridge (lets coding agents use your Chrome)

[Service]
ExecStart=${quote(ctx.nodePath)} ${quote(ctx.cliPath)} serve
Environment=${quote(`PATH=${pathEnv}`)}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`
  };
}

/**
 * Install the login service. Returns whether it now runs the Bridge; when
 * it does not (no systemd user session, for example), the caller starts the
 * Bridge directly instead.
 */
export async function installService(ctx) {
  const service = serviceDefinition(ctx);
  await writeTextFile(service.file, service.content);
  if (service.kind === "systemd") {
    const systemctl = ctx.which("systemctl");
    if (!systemctl || ctx.run(systemctl, ["--user", "daemon-reload"]).code !== 0) {
      return { ...service, running: false, note: "No systemd user session; the Bridge will start now but not at login." };
    }
    const enabled = ctx.run(systemctl, ["--user", "enable", "--now", "browserharness-bridge.service"]);
    return { ...service, running: enabled.code === 0, note: enabled.code === 0 ? undefined : enabled.stderr.trim() };
  }
  if (service.kind === "launchd") {
    const uid = typeof process.getuid === "function" ? process.getuid() : 501;
    ctx.run("launchctl", ["bootout", `gui/${uid}`, service.file]);
    let loaded = ctx.run("launchctl", ["bootstrap", `gui/${uid}`, service.file]);
    if (loaded.code !== 0) loaded = ctx.run("launchctl", ["load", "-w", service.file]);
    return { ...service, running: loaded.code === 0, note: loaded.code === 0 ? undefined : loaded.stderr.trim() };
  }
  // Windows: the Startup folder entry runs at the next login; start it now too.
  return { ...service, running: false };
}

export async function uninstallService(ctx) {
  const service = serviceDefinition(ctx);
  if (service.kind === "systemd") {
    const systemctl = ctx.which("systemctl");
    if (systemctl) {
      ctx.run(systemctl, ["--user", "disable", "--now", "browserharness-bridge.service"]);
    }
  } else if (service.kind === "launchd") {
    const uid = typeof process.getuid === "function" ? process.getuid() : 501;
    ctx.run("launchctl", ["bootout", `gui/${uid}`, service.file]);
  }
  await rm(service.file, { force: true });
  if (service.kind === "systemd") {
    const systemctl = ctx.which("systemctl");
    if (systemctl) ctx.run(systemctl, ["--user", "daemon-reload"]);
  }
  return service;
}

/**
 * A single-file build of the Bridge is copied to a fixed place so the login
 * service and agent configs keep working after the download is deleted. A
 * source checkout is used where it is.
 */
export async function stableCliPath({ cliPath, home, bundled }) {
  if (!bundled) return cliPath;
  const target = path.join(home, ".browserharness-bridge", "bin", "browserharness-bridge.mjs");
  if (path.resolve(target) !== path.resolve(cliPath)) {
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(cliPath, target);
  }
  return target;
}

/**
 * The double-click download carries its own Node. Copy it next to the helper
 * app so it keeps working after the download folder is deleted.
 */
export async function stableNodePath({ nodePath, home, bundledRuntime, platform = process.platform }) {
  if (!bundledRuntime) return nodePath;
  const target = path.join(home, ".browserharness-bridge", "runtime", platform === "win32" ? "node.exe" : "node");
  if (path.resolve(target) === path.resolve(nodePath)) return nodePath;
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(nodePath, target);
    if (platform !== "win32") await chmod(target, 0o755);
  } catch (error) {
    // An older copy may be in use; it still runs the helper app.
    if (!existsSync(target)) throw error;
  }
  return target;
}

/**
 * A `browserharness-bridge` command in ~/.local/bin when that folder is on
 * PATH (macOS and Linux), so `browserharness-bridge pair` works later.
 */
export async function installLauncher(ctx) {
  if (ctx.platform === "win32") return null;
  const dir = path.join(ctx.home, ".local", "bin");
  const onPath = String(ctx.env.PATH || "")
    .split(path.delimiter)
    .some((entry) => path.resolve(entry) === path.resolve(dir));
  if (!onPath) return null;
  const file = path.join(dir, "browserharness-bridge");
  const current = await readText(file);
  if (current !== null && !current.includes(MANAGED)) return null;
  const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  await writeTextFile(
    file,
    `#!/bin/sh\n# ${MANAGED}\nexec ${quote(ctx.nodePath)} ${quote(ctx.cliPath)} "$@"\n`,
    0o755
  );
  return file;
}

export async function uninstallLauncher(ctx) {
  const file = path.join(ctx.home, ".local", "bin", "browserharness-bridge");
  const current = await readText(file);
  if (current !== null && current.includes(MANAGED)) await rm(file, { force: true });
}
