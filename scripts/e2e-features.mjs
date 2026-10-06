#!/usr/bin/env node
// Local real-Chromium test of the Batch A features with a scripted mock model (no real LLM, no network):
// tables -> CSV, approval modes, history search + Run again, voice controls.
// Requires: npm run build, playwright-core (e.g. `npm i --no-save playwright-core`). Never runs on GitHub Actions.
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

const PAGE = `<html><head><title>Shop</title></head><body>
<h1>Shop</h1>
<table id="layout"><tr><td>Layout only</td></tr></table>
<table id="prices"><caption>Prices</caption>
  <thead><tr><th>Item</th><th>Price</th></tr></thead>
  <tbody><tr><td>Widget</td><td>₹10</td></tr><tr><td>=Gadget</td><td>20</td></tr></tbody>
</table>
<button>Rename item</button>
<button onclick="this.textContent='Item deleted'">Delete item</button>
<button onclick="this.textContent='Order placed'">Place order</button>
<iframe src="/frame" width="400" height="120"></iframe>
</body></html>`;
const FRAME = `<html><body><table><tr><th>City</th><th>Temp</th></tr><tr><td>Pune</td><td>31</td></tr></table></body></html>`;

const server = http
  .createServer((req, res) => {
    if (req.url.startsWith("/v1/chat/completions")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw);
        const user = String(body.messages.at(-1).content?.[0]?.text ?? body.messages.at(-1).content ?? "");
        const done = user.split("RECENT EXECUTION EVIDENCE:").pop() || "";
        // The goal can quote earlier turns and the prompt recalls past tasks; only the newest goal counts.
        // Past conversations recalled after the request are context, not the goal.
        const goalText = (/USER GOAL:\n([\s\S]*?)\n\nCURRENT PAGE OBSERVATION:/.exec(user)?.[1] || "").split("\n\nFROM OUR PAST CONVERSATIONS")[0];
        const latest = goalText.lastIndexOf("GOAL_TABLE") > goalText.lastIndexOf("GOAL_CLICK") ? "table" : "click";
        if (latest === "table" && goalText.includes("GOAL_TABLE")) {
          if (!/\bextract_table[: ]/.test(done)) {
            return reply(res, { kind: "tool", tool: "extract_table", input: {}, note: "Reading the tables" });
          }
          const saw = done.includes("Widget") ? "TABLE_SEEN" : "TABLE_MISSING";
          return reply(res, {
            kind: "final",
            message: `${saw}\n\n| Item | Price |\n| --- | --- |\n| Widget | ₹10 |\n| =Gadget | 20 |`
          });
        }
        const goal = [...goalText.matchAll(/GOAL_CLICK ([A-Za-z ]+)/g)].at(-1)?.[1]?.trim();
        if (goal) {
          if (!/\bclick[: ]/.test(done)) {
            const id = new RegExp(`(@e\\d+) button "${goal}"`).exec(user)?.[1];
            return reply(res, { kind: "tool", tool: "click", input: { element_id: id }, note: `Clicking ${goal}` });
          }
          return reply(res, { kind: "final", message: `CLICKED ${goal}` });
        }
        return reply(res, { kind: "final", message: "OK" });
      });
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url.startsWith("/frame")) return res.end(FRAME);
    res.end(PAGE);
  })
  .listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const port = server.address().port;

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bh-features-"));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME || "/opt/pw-browsers/chromium",
  headless: false,
  acceptDownloads: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--headless=new", "--no-sandbox"]
});

try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const extId = sw.url().split("/")[2];
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${port}/`);
  await page.waitForTimeout(500);
  const side = await ctx.newPage();
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
  const setMode = (approvalMode) =>
    side.evaluate(async (approvalMode) => {
      const key = "browserharness.preferences";
      const stored = (await chrome.storage.local.get(key))[key] || {};
      await chrome.storage.local.set({ [key]: { ...stored, approvalMode } });
    }, approvalMode);
  await side.evaluate(
    ([connection]) =>
      chrome.storage.local.set({
        "browserharness.providerConnections": [connection],
        "browserharness.runtimeRouting": { primaryConnectionId: connection.id }
      }),
    [connection]
  );
  await side.reload();
  await side.waitForTimeout(800);

  const tool = async (name, input = {}) => {
    await page.bringToFront();
    return side.evaluate(
      ([name, input]) => chrome.runtime.sendMessage({ type: "BROWSER_TOOL", tool: name, input, session_id: "features", session_title: "features" }),
      [name, input]
    );
  };
  const ask = async (text) => {
    await page.bringToFront();
    await side.locator("textarea").first().fill(text);
    await side.getByRole("button", { name: "Send" }).click();
  };
  const sideText = () => side.locator("body").innerText();
  const waitFor = (fn, arg, timeout = 20000) => side.waitForFunction(fn, arg, { timeout }).catch(() => {});
  const approvalCard = side.getByRole("button", { name: "Approve" });

  // Tables.
  const tables = await tool("extract_table");
  const list = tables.data?.tables || [];
  const prices = list.find((table) => table.caption === "Prices");
  check(
    "extract_table reads the data table with headers and rows",
    prices?.headers.join("|") === "Item|Price" && prices?.rows[0]?.join("|") === "Widget|₹10",
    JSON.stringify(prices)
  );
  check("extract_table reads a table inside a same-origin iframe", list.some((table) => table.headers.join("|") === "City|Temp" && table.rows[0]?.[0] === "Pune"));
  check("extract_table skips a one-column layout table", !list.some((table) => JSON.stringify(table).includes("Layout only")), `${list.length} tables`);

  await ask("GOAL_TABLE extract the prices table from this page");
  await waitFor(() => document.body.innerText.includes("TABLE_"));
  check("the agent calls extract_table and sees the rows", (await sideText()).includes("TABLE_SEEN"));
  check("the answer table renders as a real table", (await side.locator("td", { hasText: "Widget" }).count()) === 1);
  const download = side.waitForEvent("download", { timeout: 10000 }).catch(() => null);
  await side.getByRole("button", { name: "Download CSV" }).click({ timeout: 5000 }).catch(() => {});
  const file = await download;
  const csv = file ? fs.readFileSync(await file.path(), "utf8") : "";
  check(
    "Download CSV saves the answer table (UTF-8, formula-safe)",
    csv.startsWith("﻿") && csv.includes("Widget,₹10") && csv.includes("'=Gadget"),
    JSON.stringify(csv.slice(0, 80))
  );

  // Approval modes.
  await setMode("every");
  await ask("Click the button on this page: GOAL_CLICK Rename item");
  await approvalCard.waitFor({ timeout: 20000 }).catch(() => {});
  const everyText = await sideText();
  check("'Ask for everything' asks before a harmless click", everyText.includes("wants to: Click “Rename item”"), everyText.slice(-200).replace(/\n/g, " | "));
  await approvalCard.click().catch(() => {});
  await waitFor(() => document.body.innerText.includes("CLICKED Rename item"));
  check("approving it lets the click run", (await sideText()).includes("CLICKED Rename item"));

  await setMode("auto");
  await ask("Click the button on this page: GOAL_CLICK Delete item");
  await waitFor(() => document.body.innerText.includes("CLICKED Delete item"));
  check(
    "'Automatic' approves a risky click without a card",
    (await sideText()).includes("CLICKED Delete item") && (await page.locator("text=Item deleted").count()) === 1
  );
  await ask("Click the button on this page: GOAL_CLICK Place order");
  await approvalCard.waitFor({ timeout: 20000 }).catch(() => {});
  check("'Automatic' still asks before placing an order", await approvalCard.isVisible().catch(() => false));
  await side.getByRole("button", { name: "Cancel" }).first().click().catch(() => {});
  await page.waitForTimeout(800);
  check("cancelling leaves the order unplaced", (await page.locator("text=Order placed").count()) === 0);

  await setMode("risky");
  const clickedBefore = (await sideText()).split("CLICKED Rename item").length;
  await ask("Click the button on this page: GOAL_CLICK Rename item");
  await waitFor((n) => document.body.innerText.split("CLICKED Rename item").length > n, clickedBefore);
  check(
    "'Ask for risky' (default) clicks a harmless button without asking",
    (await sideText()).split("CLICKED Rename item").length > clickedBefore && !(await approvalCard.isVisible().catch(() => false))
  );

  // History search and Run again.
  await side.getByRole("button", { name: "Task history" }).click();
  const search = side.getByLabel("Search past tasks");
  await search.waitFor({ timeout: 5000 }).catch(() => {});
  await search.fill("prices");
  await side.waitForTimeout(300);
  const historyText = await sideText();
  check("history search finds the table task and hides the others", historyText.includes("GOAL_TABLE") && !historyText.includes("GOAL_CLICK"), historyText.slice(0, 300).replace(/\n/g, " | "));
  await search.fill("no such task zzz");
  await side.waitForTimeout(300);
  check("history search shows a no-match message", /no past task matches/i.test(await sideText()));
  await search.fill("prices");
  await side.getByRole("button", { name: "Run again" }).first().click().catch(() => {});
  await side.waitForTimeout(400);
  const draft = await side.locator("textarea").first().inputValue().catch(() => "");
  check("Run again puts the task back in the chat box", draft.includes("GOAL_TABLE"), draft);

  // Voice.
  check("answers have a Read aloud button", (await side.getByRole("button", { name: "Read aloud" }).count()) > 0);
  const canDictate = await side.evaluate(() => "webkitSpeechRecognition" in window || "SpeechRecognition" in window);
  check(
    "the mic button is shown when this browser supports dictation",
    (await side.getByRole("button", { name: "Speak your request" }).count()) > 0 === canDictate,
    `dictation available: ${canDictate}`
  );
  const mic = await ctx.newPage();
  await mic.goto(`chrome-extension://${extId}/mic.html`);
  check("the microphone permission page loads", (await mic.locator("body").innerText()).toLowerCase().includes("microphone"));
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} feature checks passed`);
process.exit(failed ? 1 : 0);
