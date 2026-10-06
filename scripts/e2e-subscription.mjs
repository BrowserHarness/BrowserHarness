#!/usr/bin/env node
// Local real-Chromium test of the subscription path: side panel -> service worker -> Local Bridge -> CLI adapter.
// The "vendor CLI" is a scripted fake (no real Claude/ChatGPT account, no network), so this proves the plumbing,
// not model quality. Requires: npm run build, playwright-core. Never runs on GitHub Actions.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createBridgeServer } from "../apps/bridge/src/core.mjs";
import { createLlmAdapterManager } from "../apps/bridge/src/llm-adapters.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "apps/extension/dist");
if (!fs.existsSync(path.join(dist, "manifest.json"))) {
  console.error("Build first: npm run build");
  process.exit(2);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "bh-sub-"));
const argLog = path.join(work, "args.log");
// Windows cannot run a #! script: stand in with the .cmd script npm writes for a CLI.
const windows = process.platform === "win32";
const fakeScript = path.join(work, windows ? "fake-claude.js" : "fake-claude");
const fakeCli = windows ? path.join(work, "fake-claude.cmd") : fakeScript;
if (windows) fs.writeFileSync(fakeCli, '@ECHO off\r\nnode  "%dp0%\\fake-claude.js" %*\r\n');
fs.writeFileSync(
  fakeScript,
  `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  if (args[0] === "--version") { console.log("fake 1.0"); return; }
  fs.appendFileSync(${JSON.stringify(argLog)}, JSON.stringify(args) + "\\n");
  const decision = input.includes("read_page:")
    ? { kind: "final", message: "Subscription says **hello mock**." }
    : input.includes("USER GOAL")
      ? { kind: "tool", tool: "read_page", input: {}, note: "Reading the page" }
      : { kind: "final", message: "OK" };
  console.log(JSON.stringify({ type: "result", is_error: false, result: JSON.stringify(decision) }));
});
`,
  { mode: 0o755 }
);

const page = http
  .createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<html><head><title>Mock Page</title></head><body><h1>hello mock</h1></body></html>");
  })
  .listen(0);
const pagePort = page.address().port;

const token = "t".repeat(40);
const bridge = createBridgeServer({
  host: "127.0.0.1",
  port: 0,
  token,
  llmManager: createLlmAdapterManager({ env: { ...process.env, BROWSERHARNESS_CLAUDE_COMMAND: fakeCli } })
});
const bridgePort = (await bridge.listen()).port;

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bh-subprof-"));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME || "/opt/pw-browsers/chromium",
  headless: false,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--headless=new", "--no-sandbox"]
});

try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const extId = sw.url().split("/")[2];
  const target = await ctx.newPage();
  await target.goto(`http://localhost:${pagePort}/`);
  const side = await ctx.newPage();
  await side.goto(`chrome-extension://${extId}/sidepanel.html`);

  const healthy = { status: "healthy", latencyMs: 1, checkedAt: new Date().toISOString() };
  const connection = {
    provider: "claude-subscription",
    apiKey: "",
    model: "default",
    id: "claude-subscription::default::default",
    label: "Claude subscription · default",
    capabilities: { chat: true, agent: true, vision: false, embedding: false, reranker: false, audio: false, image: false, unknown: false },
    chatHealth: healthy,
    agentHealth: healthy,
    embeddingHealth: { status: "unknown" }
  };
  await side.evaluate(
    ([connection, bridgePort, token]) =>
      chrome.storage.local.set({
        "browserharness.providerConnections": [connection],
        "browserharness.runtimeRouting": { primaryConnectionId: connection.id },
        "browserharness.bridgeSettings": { enabled: true, address: `ws://127.0.0.1:${bridgePort}/ws`, token }
      }),
    [connection, bridgePort, token]
  );
  await side.reload();

  const deadline = Date.now() + 15000;
  let connected = false;
  while (Date.now() < deadline && !connected) {
    const status = await (await fetch(`http://127.0.0.1:${bridgePort}/status`)).json();
    connected = status.extension_connected === true;
    if (!connected) await new Promise((r) => setTimeout(r, 300));
  }
  check("extension pairs with the Local Bridge", connected);

  await target.bringToFront();
  await side.locator("textarea").first().fill("Open the current page and read what it says");
  await side.getByRole("button", { name: "Send" }).click();
  await side.waitForFunction(() => document.body.innerText.includes("hello mock"), null, { timeout: 60000 }).catch(() => {});
  const text = await side.locator("body").innerText();
  check("agent loop runs on the subscription adapter", text.includes("Subscription says hello mock"), text.slice(-160).replace(/\n/g, " | "));

  const calls = fs.existsSync(argLog) ? fs.readFileSync(argLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  check("CLI was started with tools disabled", calls.length >= 2 && calls.every((a) => a[a.indexOf("--tools") + 1] === "" && a.includes("--no-session-persistence")), `${calls.length} calls`);
} finally {
  await ctx.close();
  await bridge.close();
  page.close();
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} subscription checks passed`);
process.exit(failed ? 1 : 0);
