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
import { spawn, spawnSync } from "node:child_process";
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

// Stand-ins for Telegram's Bot API and for a model, so the phone path runs end to end.
const telegram = { queue: [], sent: [], nextId: 1 };
const mockModel = (body, res) => {
  const user = String(body.messages.at(-1).content ?? "");
  const goal = /USER GOAL:\n([\s\S]*?)\n\nCURRENT PAGE OBSERVATION:/.exec(user)?.[1] || "";
  const done = user.split("RECENT EXECUTION EVIDENCE:").pop() || "";
  const decision = !/\bnavigate[: ]/.test(done) && goal.includes("TG_TASK")
    ? { kind: "tool", tool: "navigate", input: { url: pageUrl }, note: "Opening the page" }
    : { kind: "final", message: `TG_DONE ${/button "(\w+)"/.exec(user)?.[1] || "no button"}` };
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(decision) } }] }));
};
// Like bridge(), without blocking this process (its stand-in servers must keep answering).
const bridgeAsync = (file, ...args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      try {
        resolve({ code, json: JSON.parse(stdout.trim().split("\n").at(-1) || ""), stderr });
      } catch {
        resolve({ code, json: null, stdout, stderr });
      }
    });
  });

const page = http.createServer((req, res) => {
  if (req.method === "POST") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      if (req.url.startsWith("/v1/chat/completions")) return mockModel(body, res);
      const method = req.url.split("/").pop();
      const answer = (result) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, result }));
      };
      if (method === "getMe") return answer({ id: 1, is_bot: true, username: "my_harness_bot" });
      if (method === "sendMessage") {
        telegram.sent.push(body);
        return answer({ message_id: telegram.sent.length });
      }
      if (method === "getUpdates") {
        const deliver = () => answer(telegram.queue.splice(0).filter((update) => update.update_id >= (body.offset || 0)));
        return telegram.queue.length ? deliver() : setTimeout(deliver, 300);
      }
      res.statusCode = 404;
      res.end("{}");
    });
    return;
  }
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

  // Reach it from a phone: a Telegram message becomes a task and the result comes back.
  const tgBase = `http://127.0.0.1:${page.address().port}/tg`;
  const configFile = path.join(home, ".browserharness-bridge", "config.json");
  const withApi = JSON.parse(fs.readFileSync(configFile, "utf8"));
  fs.writeFileSync(configFile, JSON.stringify({ ...withApi, telegram: { api_base: tgBase } }));
  const healthy = { status: "healthy", latencyMs: 1, checkedAt: new Date().toISOString() };
  const modelUrl = `http://127.0.0.1:${page.address().port}/v1`;
  const connection = {
    provider: "openai-compatible",
    apiKey: "mock",
    model: "mock-agent",
    baseUrl: modelUrl,
    id: `openai-compatible::${modelUrl}::mock-agent`,
    label: "Mock",
    capabilities: { chat: true, agent: true, vision: false, embeddings: false, unknown: false },
    chatHealth: healthy,
    agentHealth: healthy,
    embeddingHealth: { status: "unknown" }
  };
  await side.evaluate(
    (connection) =>
      chrome.storage.local.set({
        "browserharness.providerConnections": [connection],
        "browserharness.runtimeRouting": { primaryConnectionId: connection.id }
      }),
    connection
  );
  const setup = await bridgeAsync(installed, "telegram", "setup", "--token", "123:abc");
  check("telegram setup checks the bot and restarts the Bridge", setup.json?.bot === "@my_harness_bot" && setup.json?.restarted === true, setup.stderr?.trim());
  const reconnected = async () => {
    for (let i = 0; i < 40; i += 1) {
      if ((await bridgeAsync(installed, "status")).json?.extension_connected) return true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  };
  check("Chrome reconnects after the restart", await reconnected());
  const tgMessage = (userId, text) =>
    telegram.queue.push({ update_id: telegram.nextId++, message: { chat: { id: 9000 + userId }, from: { id: userId, first_name: "Ada" }, text } });
  const sentTo = async (chatId, pattern, timeout = 30_000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const found = telegram.sent.find((item) => item.chat_id === chatId && pattern.test(item.text));
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return null;
  };
  tgMessage(7, "TG_TASK do something");
  check("a stranger gets no task, only how to allow them", Boolean(await sentTo(9007, /telegram allow 7/, 10_000)));
  const allow = await bridgeAsync(installed, "telegram", "allow", "42");
  check("telegram allow adds the account", allow.json?.allowed_user_ids?.includes("42"), allow.stderr?.trim());
  await reconnected();
  tgMessage(42, `TG_TASK open ${pageUrl} and tell me the button`);
  const onIt = await sentTo(9042, /^On it: TG_TASK/, 15_000);
  const finished = await sentTo(9042, /^Done\n\nTG_DONE Greet/, 60_000);
  check("an allowed message runs in Chrome and the result comes back", Boolean(onIt && finished), JSON.stringify(telegram.sent.slice(-3)));
  const history = await side.evaluate(async () => (await chrome.storage.local.get("browserharness.taskHistory"))["browserharness.taskHistory"] || []);
  check("phone tasks are in history", history.some((entry) => entry.task.startsWith("From Telegram: TG_TASK")));

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
