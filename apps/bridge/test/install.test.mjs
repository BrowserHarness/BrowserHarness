import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  detectAgents,
  installContext,
  installLauncher,
  registerAgents,
  removeManagedBlock,
  serviceDefinition,
  unregisterAgents,
  withCodexServer,
  withHermesServer
} from "../src/install.mjs";
import { SKILL_MARKER } from "../src/skill.mjs";

async function tempHome() {
  return mkdtemp(path.join(os.tmpdir(), "bh-install-"));
}

function ctxFor(home, extra = {}) {
  const runs = [];
  return {
    runs,
    ctx: installContext({
      home,
      platform: "linux",
      env: { PATH: "/usr/bin" },
      nodePath: "/usr/local/bin/node",
      cliPath: "/opt/bh/cli.mjs",
      run: (command, args) => {
        runs.push([command, ...args]);
        return { code: 0, stdout: "", stderr: "" };
      },
      which: () => null,
      ...extra
    })
  };
}

const read = (file) => readFile(file, "utf8");

test("finds only the agents installed on this computer", async () => {
  const home = await tempHome();
  try {
    await mkdir(path.join(home, ".codex"));
    await mkdir(path.join(home, ".cursor"));
    const { ctx } = ctxFor(home);
    const found = Object.fromEntries(detectAgents(ctx).map((agent) => [agent.id, agent.found]));
    assert.deepEqual(found, { claude: false, codex: true, cursor: true, hermes: false });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("registers the MCP server and skill in every agent found, keeping existing settings", async () => {
  const home = await tempHome();
  try {
    await mkdir(path.join(home, ".claude"));
    await writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify({ numStartups: 4, mcpServers: { other: { command: "x" } } })
    );
    await mkdir(path.join(home, ".codex"));
    await writeFile(path.join(home, ".codex", "config.toml"), 'model = "gpt-5"\n\n[mcp_servers.docs]\ncommand = "docs"\n');
    await mkdir(path.join(home, ".cursor"));
    await mkdir(path.join(home, ".hermes"));
    await writeFile(path.join(home, ".hermes", "config.yaml"), "model: hermes-4\nmcp_servers:\n    github:\n      command: gh\n");

    const { ctx } = ctxFor(home);
    const results = await registerAgents(ctx);
    assert.deepEqual(results.map((result) => result.status), ["connected", "connected", "connected", "connected"]);

    const claude = JSON.parse(await read(path.join(home, ".claude.json")));
    assert.equal(claude.numStartups, 4);
    assert.deepEqual(claude.mcpServers.other, { command: "x" });
    assert.deepEqual(claude.mcpServers.browserharness, {
      type: "stdio",
      command: "/usr/local/bin/node",
      args: ["/opt/bh/cli.mjs", "mcp"],
      env: {}
    });
    assert.ok(existsSync(path.join(home, ".claude.json.before-browserharness")));

    const toml = await read(path.join(home, ".codex", "config.toml"));
    assert.match(toml, /^model = "gpt-5"/);
    assert.match(toml, /\[mcp_servers\.docs\]/);
    assert.match(toml, /\[mcp_servers\.browserharness\]\ncommand = "\/usr\/local\/bin\/node"\nargs = \["\/opt\/bh\/cli\.mjs", "mcp"\]/);

    const cursor = JSON.parse(await read(path.join(home, ".cursor", "mcp.json")));
    assert.equal(cursor.mcpServers.browserharness.command, "/usr/local/bin/node");

    const yaml = await read(path.join(home, ".hermes", "config.yaml"));
    assert.match(yaml, /mcp_servers:\n {4}# >>> browserharness[^\n]*\n {4}browserharness:\n {6}command: "\/usr\/local\/bin\/node"/);
    assert.match(yaml, /github:\n {6}command: gh/);

    for (const skill of [
      ".claude/skills/browserharness/SKILL.md",
      ".agents/skills/browserharness/SKILL.md",
      ".hermes/skills/browserharness/SKILL.md"
    ]) {
      const text = await read(path.join(home, skill));
      assert.match(text, /^---\nname: browserharness\ndescription: /);
      assert.ok(text.includes(SKILL_MARKER));
    }
    // Cursor reads the Claude and Codex skill folders already.
    assert.equal(existsSync(path.join(home, ".cursor/skills/browserharness")), false);

    // Installing twice changes nothing.
    await registerAgents(ctx);
    assert.equal(await read(path.join(home, ".codex", "config.toml")), toml);
    assert.equal(await read(path.join(home, ".hermes", "config.yaml")), yaml);

    await unregisterAgents(ctx);
    const after = JSON.parse(await read(path.join(home, ".claude.json")));
    assert.equal(after.mcpServers.browserharness, undefined);
    assert.deepEqual(after.mcpServers.other, { command: "x" });
    assert.equal(await read(path.join(home, ".codex", "config.toml")), 'model = "gpt-5"\n\n[mcp_servers.docs]\ncommand = "docs"\n');
    assert.equal(await read(path.join(home, ".hermes", "config.yaml")), "model: hermes-4\nmcp_servers:\n    github:\n      command: gh\n");
    assert.equal(existsSync(path.join(home, ".claude/skills/browserharness")), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("uses the claude command when it is installed", async () => {
  const home = await tempHome();
  try {
    const { ctx, runs } = ctxFor(home, { which: (name) => (name === "claude" ? "/bin/claude" : null) });
    const [claude] = await registerAgents(ctx, { only: ["claude"] });
    assert.equal(claude.status, "connected");
    assert.deepEqual(runs.at(-1), [
      "/bin/claude", "mcp", "add", "--scope", "user", "browserharness", "--",
      "/usr/local/bin/node", "/opt/bh/cli.mjs", "mcp"
    ]);
    assert.equal(existsSync(path.join(home, ".claude.json")), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("never overwrites a broken config or a hand-written entry", async () => {
  const home = await tempHome();
  try {
    await mkdir(path.join(home, ".cursor"));
    await writeFile(path.join(home, ".cursor", "mcp.json"), "{ not json");
    await mkdir(path.join(home, ".codex"));
    await writeFile(path.join(home, ".codex", "config.toml"), '[mcp_servers.browserharness]\ncommand = "mine"\n');
    const { ctx } = ctxFor(home);
    const results = Object.fromEntries((await registerAgents(ctx)).map((result) => [result.id, result]));
    assert.equal(results.cursor.status, "failed");
    assert.match(results.cursor.error, /not valid JSON/);
    assert.equal(await read(path.join(home, ".cursor", "mcp.json")), "{ not json");
    assert.equal(results.codex.status, "failed");
    assert.equal(await read(path.join(home, ".codex", "config.toml")), '[mcp_servers.browserharness]\ncommand = "mine"\n');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("config edits handle empty files and Windows paths", () => {
  const ctx = { nodePath: "C:\\Program Files\\nodejs\\node.exe", cliPath: "C:\\Users\\a\\bh.mjs" };
  const toml = withCodexServer("", ctx).text;
  assert.match(toml, /command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"/);
  assert.equal(removeManagedBlock(toml).trim(), "");
  const yaml = withHermesServer("mcp_servers: {}\n", ctx).text;
  assert.match(yaml, /^mcp_servers:\n {2}# >>> browserharness/);
  const fresh = withHermesServer(null, ctx).text;
  assert.match(fresh, /mcp_servers:\n {2}browserharness:/);
  assert.equal(removeManagedBlock(fresh).trim(), "");
});

test("login service files start the Bridge on every platform", () => {
  const base = { home: "/home/a", nodePath: "/usr/bin/node", cliPath: "/home/a/bh.mjs", env: { PATH: "/usr/bin:/home/a/.local/bin" } };
  const linux = serviceDefinition({ ...base, platform: "linux" });
  assert.equal(linux.file, "/home/a/.config/systemd/user/browserharness-bridge.service");
  assert.match(linux.content, /ExecStart="\/usr\/bin\/node" "\/home\/a\/bh\.mjs" serve/);
  assert.match(linux.content, /Environment="PATH=\/usr\/bin:\/home\/a\/\.local\/bin"/);
  const mac = serviceDefinition({ ...base, platform: "darwin" });
  assert.equal(mac.file, "/home/a/Library/LaunchAgents/com.browserharness.bridge.plist");
  assert.match(mac.content, /<string>serve<\/string>/);
  assert.match(mac.content, /<key>RunAtLoad<\/key><true\/>/);
  const windows = serviceDefinition({ ...base, platform: "win32", env: { APPDATA: "C:\\Users\\a\\AppData\\Roaming" } });
  assert.match(windows.file, /Startup[\\/]BrowserHarness Bridge\.vbs$/);
  assert.match(windows.content, /Run """\/usr\/bin\/node"" ""\/home\/a\/bh\.mjs"" serve", 0, False/);
});

test("adds a browserharness-bridge command only when ~/.local/bin is on PATH", async () => {
  const home = await tempHome();
  try {
    const { ctx } = ctxFor(home);
    assert.equal(await installLauncher(ctx), null);
    const onPath = { ...ctx, env: { PATH: `/usr/bin${path.delimiter}${path.join(home, ".local", "bin")}` } };
    const file = await installLauncher(onPath);
    assert.match(await read(file), /exec '\/usr\/local\/bin\/node' '\/opt\/bh\/cli\.mjs' "\$@"/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
