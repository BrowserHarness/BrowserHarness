#!/usr/bin/env node
// Local real-Chromium test of acting helpers with a scripted mock model (no real LLM, no network):
// one request splits into two helpers that each click and type in their own background tab at
// the same time, a risky step asks the person and says which helper wants it, helpers can't
// touch the person's tab, and their tabs are closed when they finish.
// Requires: npm run build, playwright-core. Never runs on GitHub Actions.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "apps/extension/dist");
if (!fs.existsSync(path.join(dist, "manifest.json"))) {
  console.error("Build first: npm run build");
  process.exit(2);
}

const reply = (res, content) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(content) } }] }));
};

const shop = (name, button) => `<html><head><title>${name}</title></head><body>
<h1>${name}</h1>
<input aria-label="Search">
<button onclick="fetch('/cart?shop=${encodeURIComponent(name)}&item='+encodeURIComponent(document.querySelector('input').value),{method:'POST'}).then(()=>{document.getElementById('out').textContent='Added '+document.querySelector('input').value})">${button}</button>
<p id="out"></p>
</body></html>`;
const HOME = `<html><head><title>My page</title></head><body><h1>My page</h1><button onclick="document.title='TOUCHED'">Do not touch</button></body></html>`;

const systems = [];
const cart = [];
const timeline = [];
const calls = new Map();
let refusalSeen = false;
let port = 0;
const server = http
  .createServer((req, res) => {
    if (req.url.startsWith("/cart")) {
      const query = new URL(req.url, "http://x").searchParams;
      cart.push(`${query.get("shop")}: ${query.get("item")}`);
      return res.end("ok");
    }
    if (req.url.startsWith("/v1/chat/completions")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw);
        const system = String(body.messages.find((m) => m.role === "system")?.content || "");
        const user = String(body.messages.at(-1).content?.[0]?.text ?? body.messages.at(-1).content ?? "");
        const ref = (pattern) => new RegExp(`(@e\\d+) ${pattern}`).exec(user)?.[1];
        const subtask = /WORKER SUBTASK:\n([^\n]+)/.exec(user)?.[1];
        if (subtask) {
          systems.push(system);
          const which = subtask.includes("Shop A") ? "A" : "B";
          const step = (calls.get(subtask) || 0) + 1;
          calls.set(subtask, step);
          timeline.push(`${which}${step}`);
          // The refusal is evidence for helper A's very next decision.
          if (which === "A" && step === 2 && user.includes("only in tabs they opened")) refusalSeen = true;
          const url = `http://localhost:${port}/shop${which.toLowerCase()}`;
          const button = which === "A" ? "Add to cart" : "Buy now";
          // Helper A first tries the person's own tab, which must be refused.
          const planA = [
            { kind: "tool", tool: "click", input: { element_id: ref('button "Do not touch"') || "@e1" }, note: "Trying the current tab" },
            { kind: "tool", tool: "open_tab", input: { url }, note: "Opening Shop A" }
          ];
          const plan = [
            ...(which === "A" ? planA : [{ kind: "tool", tool: "open_tab", input: { url }, note: "Opening Shop B" }]),
            { kind: "tool", tool: "type", input: { element_id: ref('textbox "Search"'), text: "green tea" }, note: "Typing" },
            { kind: "tool", tool: "click", input: { element_id: ref(`button "${button}"`) }, note: `Clicking ${button}` }
          ];
          if (plan[step - 1]) return setTimeout(() => reply(res, plan[step - 1]), 150);
          const refused = which === "A" && refusalSeen ? " (current tab refused)" : "";
          return reply(res, { kind: "final", message: `ADDED green tea at Shop ${which}${refused}` });
        }
        const goal = (/USER GOAL:\n([\s\S]*?)\n\nCURRENT PAGE OBSERVATION:/.exec(user)?.[1] || "")?.split("\n\nEARLIER IN THIS CHAT")[0];
        if (goal.includes("HELPERS_TASK")) {
          // Only this run's evidence counts, not past conversations recalled into the goal.
          const evidence = user.slice(user.indexOf("CURRENT PAGE OBSERVATION:"));
          if (!evidence.includes('"worker_count"')) {
            const again = goal.includes("HELPERS_TASK2") ? " again" : "";
            return reply(res, {
              kind: "tool",
              tool: "agent",
              input: { act: true, tasks: [`Add green tea to the cart on Shop A${again}`, `Buy green tea on Shop B${again}`] },
              note: "Splitting the work"
            });
          }
          const found = [...new Set(evidence.match(/ADDED green tea at Shop [AB]( \(current tab refused\))?/g) || [])].sort();
          return reply(res, { kind: "final", message: `HELPERS_DONE ${found.join(" | ")}${evidence.includes("I stopped before that action") ? " | B_DECLINED" : ""}` });
        }
        return reply(res, { kind: "final", message: "OK" });
      });
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url.startsWith("/shopa")) return res.end(shop("Shop A", "Add to cart"));
    if (req.url.startsWith("/shopb")) return res.end(shop("Shop B", "Buy now"));
    res.end(HOME);
  })
  .listen(0);
await new Promise((resolve) => server.once("listening", resolve));
port = server.address().port;

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bh-helpers-"));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME || "/opt/pw-browsers/chromium",
  headless: false,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--headless=new", "--no-sandbox"]
});

try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const extId = sw.url().split("/")[2];
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${port}/`);
  const side = await ctx.newPage();
  await side.setViewportSize({ width: 430, height: 1400 });
  await side.goto(`chrome-extension://${extId}/sidepanel.html`);
  const healthy = { status: "healthy", latencyMs: 1, checkedAt: new Date().toISOString() };
  const connection = {
    provider: "openai-compatible",
    apiKey: "mock",
    model: "mock-agent",
    baseUrl: `http://localhost:${port}/v1`,
    id: `openai-compatible::http://localhost:${port}/v1::mock-agent`,
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
        "browserharness.runtimeRouting": { primaryConnectionId: connection.id },
        "browserharness.preferences": { autoSkills: false }
      }),
    connection
  );
  await side.reload();
  await side.waitForTimeout(800);
  const tabsBefore = ctx.pages().length;

  await page.bringToFront();
  await side.locator("textarea").first().fill("HELPERS_TASK add green tea to the cart on Shop A and buy it on Shop B");
  await side.getByRole("button", { name: "Send" }).click();

  // The risky step asks the person and names the helper.
  const approve = side.getByRole("button", { name: "Approve" });
  await approve.waitFor({ timeout: 30000 }).catch(() => {});
  const asking = await side.locator("body").innerText();
  check("a risky helper step asks the person and says which helper wants it", /wants to: Helper 2 \(Buy green tea on Shop B\): .*“Buy now”/.test(asking), asking.slice(-400).replace(/\n/g, " | "));
  const helperTabs = ctx.pages().filter((p) => /\/shop[ab]/.test(p.url()));
  check("each helper works in its own tab", helperTabs.length === 2, ctx.pages().map((p) => p.url()).join(", "));
  const helperTabState = await side.evaluate(async () => (await chrome.tabs.query({})).filter((tab) => /\/shop[ab]/.test(tab.url || "")).map((tab) => tab.active));
  check("helper tabs stay in the background", helperTabState.length === 2 && helperTabState.every((active) => !active), JSON.stringify(helperTabState));
  if (process.env.SHOT_DIR) await side.screenshot({ path: path.join(process.env.SHOT_DIR, "helpers-approval.png"), fullPage: true });
  await approve.click().catch(() => {});

  await side.waitForFunction(() => document.body.innerText.includes("HELPERS_DONE"), null, { timeout: 40000 }).catch(() => {});
  const text = await side.locator("body").innerText();
  check(
    "both helpers finished and the answer has both results",
    text.includes("HELPERS_DONE ADDED green tea at Shop A (current tab refused) | ADDED green tea at Shop B"),
    text.slice(-500).replace(/\n/g, " | ")
  );
  check("helpers ran at the same time", timeline.includes("B1") && timeline.includes("A5") && timeline.indexOf("B1") < timeline.indexOf("A5"), timeline.join(" "));
  check("the clicks happened on both shops", cart.includes("Shop A: green tea") && cart.includes("Shop B: green tea"), cart.join(", "));
  check("helpers use the acting helper instructions", systems.length > 0 && systems.every((s) => s.includes("You are a BrowserHarness helper")));
  check("a helper cannot act in the person's tab", (await page.title()) === "My page");
  check("the activity list shows the helpers", /Helper [12]/.test(text));
  await side.waitForTimeout(1000);
  check("helper tabs are closed when they finish", !ctx.pages().some((p) => /\/shop[ab]/.test(p.url())) && ctx.pages().length === tabsBefore, ctx.pages().map((p) => p.url()).join(", "));
  if (process.env.SHOT_DIR) await side.screenshot({ path: path.join(process.env.SHOT_DIR, "helpers-done.png"), fullPage: true });

  // Declining one helper's risky step stops only that helper.
  const cartBefore = cart.length;
  await page.bringToFront();
  await side.locator("textarea").first().fill("HELPERS_TASK2 add green tea to the cart on Shop A and buy it on Shop B");
  await side.getByRole("button", { name: "Send" }).click();
  await approve.waitFor({ timeout: 30000 }).catch(() => {});
  await side.getByRole("button", { name: "Cancel" }).first().click().catch(() => {});
  await side.waitForFunction(() => document.body.innerText.split("HELPERS_DONE").length > 2, null, { timeout: 40000 }).catch(() => {});
  const second = (await side.locator("body").innerText()).split("HELPERS_DONE").at(-1) || "";
  check(
    "declining one helper's step stops only that helper",
    second.includes("ADDED green tea at Shop A") && !second.includes("Shop B (") && second.includes("B_DECLINED") && cart.slice(cartBefore).join(",") === "Shop A: green tea",
    `${second.slice(0, 200).replace(/\n/g, " | ")} cart: ${cart.slice(cartBefore).join(",")}`
  );
} catch (error) {
  check("helpers e2e ran without crashing", false, error instanceof Error ? error.stack : String(error));
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} helper checks passed`);
process.exit(failed ? 1 : 0);
