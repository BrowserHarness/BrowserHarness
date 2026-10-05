#!/usr/bin/env node
// Local real-Chromium test of one-command agent connect: the single-file Bridge
// installs into a temporary home folder with fake Claude Code, Codex, Cursor and
// Hermes folders, the extension pairs by code (no token copy), and an MCP
// client (standing in for a coding agent) completes a small task in Chrome.
// Requires: npm run build, npm run build:bridge, playwright-core. Never runs on GitHub Actions.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "apps/extension/dist");
const bundle = path.join(root, "apps/bridge/dist/browserharness-bridge.mjs");
for (const file of [path.join(dist, "manifest.json"), bundle]) {
  if (!fs.existsSync(file)) {
    console.error("Build first: npm run build && npm run build:bridge");
    process.exit(2);
  }
}
const { Client } = await import(
  require.resolve("@modelcontextprotocol/client", { paths: [path.join(root, "apps/bridge")] })
);
const { StdioClientTransport } = await import(
  require.resolve("@modelcontextprotocol/client/stdio", { paths: [path.join(root, "apps/bridge")] })
);

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// A temporary home folder with four coding agents "installed".
const home = fs.mkdtempSync(path.join(os.tmpdir(), "bh-home-"));
for (const dir of [".claude", ".codex", ".cursor", ".hermes"]) fs.mkdirSync(path.join(home, dir));
fs.writeFileSync(path.join(home, ".codex", "config.toml"), 'model = "gpt-5"\n');
const port = 10_200 + Math.floor(Math.random() * 500);
fs.mkdirSync(path.join(home, ".browserharness-bridge"));
fs.writeFileSync(
  path.join(home, ".browserharness-bridge", "config.json"),
  JSON.stringify({ host: "127.0.0.1", port, allow_remote: false, token: "e2e-" + Math.random().toString(36).slice(2) })
);
// The real `claude` command is used when it exists; it writes into this home.
const env = { ...process.env, HOME: home, USERPROFILE: home };
const installed = path.join(home, ".browserharness-bridge", "bin", "browserharness-bridge.mjs");
const bridge = (file, ...args) => {
  const run = spawnSync(process.execPath, [file, ...args], { env, encoding: "utf8", timeout: 60_000 });
  const last = run.stdout.trim().split("\n").at(-1) || "";
  try {
    return { code: run.status, json: JSON.parse(last), stderr: run.stderr };
  } catch {
    return { code: run.status, json: null, stdout: run.stdout, stderr: run.stderr };
  }
};

const page = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><title>Agent task</title>
<label>Name <input id="name" aria-label="name"></label>
<button onclick="document.getElementById('out').textContent='Hello, '+document.getElementById('name').value+'!'">Greet</button>
<p id="out"></p>`);
});
await new Promise((resolve) => page.listen(0, "127.0.0.1", resolve));
const pageUrl = `http://127.0.0.1:${page.address().port}/`;

let ctx;
let mcp;
try {
  // 1. One command installs the Bridge and connects the agents.
  const install = bridge(bundle, "install", "--json", "--no-service", "--no-pair");
  check("install finishes", install.code === 0 && install.json?.installed === true, install.stderr?.trim());
  const agents = Object.fromEntries((install.json?.agents || []).map((agent) => [agent.id, agent.status]));
  check("install connects Claude Code, Codex, Cursor and Hermes", Object.values(agents).filter((s) => s === "connected").length === 4, JSON.stringify(agents));
  check("install copies the Bridge to a fixed place", fs.existsSync(installed));
  const codex = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
  check("Codex config keeps its settings and gains browserharness", codex.startsWith('model = "gpt-5"') && codex.includes(`args = [${JSON.stringify(installed)}, "mcp"]`));
  const claudeJson = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
  check("Claude Code has the browserharness MCP server", claudeJson.mcpServers?.browserharness?.args?.[0] === installed);
  check("skill files are written", fs.existsSync(path.join(home, ".claude/skills/browserharness/SKILL.md")) && fs.existsSync(path.join(home, ".hermes/skills/browserharness/SKILL.md")));
  const status = bridge(installed, "status");
  check("Bridge is running", status.json?.running === true && status.json?.extension_connected === false);

  // 2. The extension pairs by code.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bh-bridge-"));
  ctx = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME || "/opt/pw-browsers/chromium",
    headless: false,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--headless=new", "--no-sandbox"]
  });
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const extId = sw.url().split("/")[2];
  const side = await ctx.newPage();
  await side.setViewportSize({ width: 430, height: 1200 });
  await side.goto(`chrome-extension://${extId}/sidepanel.html`);
  await side.evaluate(async (address) => {
    await chrome.storage.local.set({
      "browserharness.bridgeSettings": { enabled: false, address, token: "" }
    });
  }, `ws://127.0.0.1:${port}/ws`);
  await side.reload();
  await side.getByRole("button", { name: "Settings" }).first().click();
  await side.getByText("Coding agents", { exact: true }).waitFor({ timeout: 10000 });
  await side.getByRole("button", { name: "Pair", exact: true }).click();
  const codeText = await side.getByLabel("Pairing code").innerText({ timeout: 10000 });
  const code = codeText.replace(/\D/g, "");
  check("Pair shows a 6-digit code", /^\d{6}$/.test(code), codeText);
  if (process.env.SHOT_DIR) await side.screenshot({ path: path.join(process.env.SHOT_DIR, "pair-code.png") });

  const wrong = bridge(installed, "pair", "--code", code === "000000" ? "111111" : "000000", "--json");
  check("a wrong code is refused", wrong.code !== 0);
  const paired = bridge(installed, "pair", "--code", code, "--json");
  check("typing the code pairs the extension", paired.json?.paired === true && paired.json?.extension_connected === true, paired.stderr?.trim());
  await side.getByText("Connected. Ask your coding agent").waitFor({ timeout: 10000 });
  check("side panel says Connected", true);
  if (process.env.SHOT_DIR) await side.screenshot({ path: path.join(process.env.SHOT_DIR, "pair-connected.png") });

  // 3. An agent drives Chrome through MCP with typed tools.
  mcp = new Client({ name: "e2e-agent", version: "1.0.0" });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [installed, "mcp"], env, stderr: "ignore" }));
  const tools = (await mcp.listTools()).tools;
  const click = tools.find((tool) => tool.name === "browserharness_click");
  check("MCP lists typed tools", tools.length === 37 && click?.inputSchema?.required?.includes("element_id"), `${tools.length} tools`);
  let browserCalls = 0;
  // Returns the tool's outcome (JSON) and the page text it carried, if any.
  const call = async (name, args = {}) => {
    if (name !== "browserharness_status") browserCalls += 1;
    const result = await mcp.callTool({ name, arguments: { session: "e2e-greet", title: "Greet test", ...args } });
    const texts = result.content.map((part) => part.text);
    const page = texts.find((text) => text.startsWith("Page after this action:") || text.startsWith("tab_id:")) || "";
    let outcome;
    try {
      outcome = JSON.parse(texts[0]);
    } catch {
      outcome = { ok: !result.isError };
    }
    return { ...outcome, page };
  };
  const ref = (page, pattern) => page.split("\n").find((line) => pattern.test(line))?.split(" ")[0];
  const st = await call("browserharness_status");
  check("agent sees the extension connected", st.ok && st.data.extension_connected === true);
  const opened = await call("browserharness_open_tab", { url: pageUrl });
  const input = ref(opened.page, /textbox "name"/);
  const button = ref(opened.page, /button "Greet"/);
  check("opening a tab returns the page with @e refs", opened.ok && /^@e\d+$/.test(input || "") && /^@e\d+$/.test(button || ""), opened.page.slice(0, 300));
  const typed = await call("browserharness_type", { element_id: input, text: "Ada" });
  const clicked = await call("browserharness_click", { element_id: button });
  check("agent completes the task from the pages actions return", typed.ok && clicked.ok && clicked.page.includes("Hello, Ada!"), JSON.stringify(clicked.error || typed.error || ""));
  check("three browser calls instead of five (no separate observe)", browserCalls === 3, `${browserCalls} calls`);
  const observed = await call("browserharness_observe_page");
  check("observe_page answers as compact text", /^tab_id: \d+\nurl: http/.test(observed.page) && observed.page.includes('button "Greet"'));
  const closed = await call("browserharness_close_session");
  check("agent closes its tabs", closed.ok);

  // Saved Skills reach coding agents (MCP) and the command line.
  await side.evaluate(() =>
    chrome.storage.local.set({
      "browserharness.skills": [
        {
          id: "s1",
          name: "Find red shoes",
          slug: "find-red-shoes",
          description: "Search the shop for red shoes",
          instructions: "Goal: search the shop\n1. Type “red shoes” into “Search”\n2. Press Enter",
          source: "chat",
          created_at: "",
          updated_at: "",
          runs: 0,
          successes: 0,
          failures: 0,
          lessons: []
        }
      ]
    })
  );
  const listed = await mcp.callTool({ name: "browserharness_skills", arguments: {} });
  const steps = await mcp.callTool({ name: "browserharness_skills", arguments: { name: "find-red-shoes", details: "size 9" } });
  check(
    "coding agents list Skills and get one Skill's steps",
    listed.content[0].text.includes('"name": "find-red-shoes"') &&
      steps.content[0].text.includes("1. Type “red shoes” into “Search”") &&
      steps.content[0].text.includes("This time: size 9"),
    steps.content[0].text.slice(0, 200)
  );
  const cli = spawnSync(process.execPath, [installed, "skill", "find-red-shoes", "size", "9"], { env, encoding: "utf8", timeout: 30_000 });
  const cliList = spawnSync(process.execPath, [installed, "skills"], { env, encoding: "utf8", timeout: 30_000 });
  check(
    "the command line lists and prints Skills",
    cli.status === 0 && cli.stdout.includes("Use my saved Skill “Find red shoes”") && cliList.stdout.includes("find-red-shoes"),
    (cli.stderr || cliList.stderr || "").trim()
  );
  await mcp.close();
  mcp = undefined;

  // 4. Uninstall removes what install added.
  const removed = bridge(installed, "uninstall");
  const afterClaude = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
  check(
    "uninstall removes agents, skills and the Bridge",
    removed.code === 0 &&
      !afterClaude.mcpServers?.browserharness &&
      fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8") === 'model = "gpt-5"\n' &&
      !fs.existsSync(path.join(home, ".claude/skills/browserharness")) &&
      bridge(bundle, "status").json?.running === false,
    removed.stderr?.trim()
  );
} catch (error) {
  check("bridge e2e ran without crashing", false, error instanceof Error ? error.stack : String(error));
} finally {
  await mcp?.close().catch(() => undefined);
  await ctx?.close().catch(() => undefined);
  bridge(bundle, "stop");
  page.close();
  fs.rmSync(home, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} bridge checks passed`);
process.exit(passed === results.length ? 0 : 1);
