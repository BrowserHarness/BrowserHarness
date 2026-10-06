#!/usr/bin/env node
// Local real-Chromium test of the full agent loop with a scripted mock model (no real LLM, no network).
// Drives the real side-panel UI: prompt -> planner -> tools -> final answer, including a Task DAG with a verifier.
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

const modelCalls = [];
const reply = (res, content) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(content) } }] }));
};

const server = http
  .createServer((req, res) => {
    if (req.url.startsWith("/v1/chat/completions")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw);
        const user = String(body.messages.at(-1).content?.[0]?.text ?? body.messages.at(-1).content ?? "");
        const system = String(body.messages[0].content ?? "");
        if (user.includes("Ask up to 4 short questions")) {
          const questions = user.includes("find shoes for me")
            ? [{ question: "What size?", choices: ["UK 7", "UK 8"] }, { question: "Any budget?", choices: ["Under £50", "No limit"] }]
            : [];
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ questions }) } }] }));
        }
        if (user.includes("Rewrite the browser-task request below")) {
          const content = user.includes("A: UK 8") ? "Find shoes for me in UK size 8." : "Open the current page and report its main heading.";
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
        }
        const isWorker = user.includes("WORKER SUBTASK:");
        modelCalls.push(isWorker ? "worker" : "main");
        if (isWorker) {
          if (user.includes("independent read-only VERIFIER")) {
            return reply(res, { kind: "final", message: "VERDICT: supported. Checked the page title myself." });
          }
          return reply(res, { kind: "final", message: "Claim: the page is titled Mock Page." });
        }
        if (user.includes("GOAL_SEARCH")) {
          // A small-model style run: a bad element id first, a bare URL, then type + Enter.
          const done = user.split("RECENT EXECUTION EVIDENCE:").pop() || "";
          if (!/\bclick[: ]/.test(done)) {
            return reply(res, { kind: "tool", tool: "click", input: { element_id: "@e999" }, note: "Clicking a stale element" });
          }
          if (!/\bnavigate[: ]/.test(done)) {
            return reply(res, { kind: "tool", tool: "navigate", url: `localhost:${port}/form`, note: "Opening the search page" });
          }
          const box = /(@e\d+) textbox "Search"/.exec(user)?.[1];
          if (!/\btype[: ]/.test(done) && box) {
            return reply(res, { kind: "tool", tool: "type", input: { element_id: box, text: "red shoes" }, note: "Typing the search" });
          }
          if (!/\bpress_key[: ]/.test(done) && box) {
            return reply(res, { kind: "tool", tool: "press_key", input: { element_id: box, key: "Enter" }, note: "Pressing Enter" });
          }
          return reply(res, {
            kind: "final",
            message: user.includes("Results for red shoes") ? "SEARCH_OK results page reached." : "SEARCH_FAILED no results page."
          });
        }
        if (user.includes("GOAL_APPROVE")) {
          if (!user.includes("click:")) {
            const id = /(@e\d+) button "Delete account"/.exec(user)?.[1] || /(@e\d+) /.exec(user)?.[1];
            return reply(res, { kind: "tool", tool: "click", input: { element_id: id }, note: "Clicking delete" });
          }
          return reply(res, { kind: "final", message: "Clicked it." });
        }
        if (user.includes("GOAL_DAG")) {
          if (!user.includes("agent:")) {
            return reply(res, {
              kind: "tool",
              tool: "agent",
              input: {
                dag: [
                  { id: "a", task: "Find the page title", type: "research" },
                  { id: "v", task: "Check the claimed title", type: "verify", dependencies: ["a"] }
                ]
              },
              note: "Delegating with verification"
            });
          }
          return reply(res, { kind: "final", message: "DAG finished: **verified** title." });
        }
        if (!user.includes("read_page:")) {
          return reply(res, { kind: "tool", tool: "read_page", input: {}, note: "Reading the page" });
        }
        return reply(res, { kind: "final", message: "The page says **hello mock**." });
      });
      return;
    }
    res.setHeader("content-type", "text/html");
    if (req.url.startsWith("/form")) {
      return res.end('<html><head><title>Search</title></head><body><form action="/results"><input name="q" aria-label="Search"></form></body></html>');
    }
    if (req.url.startsWith("/results")) {
      const q = new URL(req.url, "http://x").searchParams.get("q") || "";
      return res.end(`<html><head><title>Results</title></head><body><h1>Results for ${q.replace(/[<>&]/g, "")}</h1></body></html>`);
    }
    res.end("<html><head><title>Mock Page</title></head><body><h1>hello mock</h1><button>Delete account</button></body></html>");
  })
  .listen(0);
const port = server.address().port;

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bh-agent-"));
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
    ([connection]) =>
      chrome.storage.local.set({
        "browserharness.providerConnections": [connection],
        "browserharness.runtimeRouting": { primaryConnectionId: connection.id }
      }),
    [connection]
  );
  await side.reload();
  await side.waitForTimeout(800);

  const ask = async (text) => {
    await page.bringToFront();
    const box = side.locator("textarea").first();
    await box.fill(text);
    await side.getByRole("button", { name: "Send" }).click();
  };
  const assistantTexts = () =>
    side.evaluate(() => [...document.querySelectorAll("p, strong")].map((n) => n.textContent));

  await side.locator("textarea").first().fill("whats on the page");
  await side.getByRole("button", { name: "Polish request" }).click();
  await side.waitForFunction(() => document.querySelector("textarea")?.value.includes("main heading"), null, { timeout: 10000 }).catch(() => {});
  check("prompt polish rewrites the draft via the model", (await side.locator("textarea").first().inputValue()).includes("main heading"));
  check("the model menu, Polish and Send sit under the chat box", (await side.locator('[data-testid="composer"] [aria-label="Choose model"]').count()) === 1 && (await side.locator('[data-testid="composer"] [aria-label="Polish request"]').count()) === 1 && (await side.locator("header [aria-label='Choose model']").count()) === 0);

  await side.locator("textarea").first().fill("find shoes for me");
  await side.getByRole("button", { name: "Polish request" }).click();
  const polishDialog = side.getByRole("dialog", { name: "Improve my request" });
  await polishDialog.getByText("What size?").waitFor({ timeout: 10000 }).catch(() => {});
  check("Polish asks a few questions with answers to tap", (await polishDialog.getByText("What size?").count()) === 1 && (await polishDialog.getByRole("button", { name: "UK 8" }).count()) === 1);
  if (process.env.SHOT_DIR) { await side.setViewportSize({ width: 430, height: 900 }); await side.waitForTimeout(500); await side.screenshot({ path: path.join(process.env.SHOT_DIR, "polish-questions.png") }); }
  await polishDialog.getByRole("button", { name: "UK 8" }).click();
  await polishDialog.getByRole("button", { name: "Improve my request" }).click();
  await side.waitForFunction(() => document.querySelector("textarea")?.value.includes("UK size 8"), null, { timeout: 10000 }).catch(() => {});
  check("the request is rewritten with the answer", (await side.locator("textarea").first().inputValue()) === "Find shoes for me in UK size 8.");
  const polishNote = await side.getByTestId("saved-note").innerText().catch(() => "");
  check("a note says it used the answer", polishNote.includes("your 1 answer"), polishNote);
  if (process.env.SHOT_DIR) { await side.waitForTimeout(400); await side.screenshot({ path: path.join(process.env.SHOT_DIR, "polish-done.png") }); await side.setViewportSize({ width: 1280, height: 720 }); }

  await ask("Open the current page and read what it says");
  await side.waitForFunction(() => document.body.innerText.includes("hello mock"), null, { timeout: 20000 }).catch(() => {});
  const body1 = await side.locator("body").innerText();
  check("agent loop: read_page then final answer", body1.includes("The page says hello mock"), body1.slice(-160).replace(/\n/g, " | "));
  check("final answer rendered as markdown (bold)", (await side.locator("strong", { hasText: "hello mock" }).count()) > 0);

  await ask("GOAL_DAG open the page and verify its title");
  await side.waitForFunction(() => document.body.innerText.includes("DAG finished"), null, { timeout: 30000 }).catch(() => {});
  const body2 = await side.locator("body").innerText();
  check("Task DAG with verifier completes", body2.includes("DAG finished"), body2.slice(-160).replace(/\n/g, " | "));
  check("DAG ran research + verifier workers", modelCalls.filter((c) => c === "worker").length === 2, modelCalls.join(","));

  await ask("GOAL_APPROVE click the delete button on this page");
  const grantButton = side.getByRole("button", { name: "Always allow on this site" });
  await grantButton.waitFor({ timeout: 20000 }).catch(() => {});
  check("risky click shows an approval card with a site-grant option", await grantButton.isVisible().catch(() => false));
  await grantButton.click().catch(() => {});
  await side.waitForFunction(() => document.body.innerText.includes("Clicked it."), null, { timeout: 20000 }).catch(() => {});
  check("granting approves the action", (await side.locator("body").innerText()).includes("Clicked it."));

  await ask("GOAL_APPROVE click the delete button on this page again");
  await side.waitForFunction(() => document.body.innerText.split("Clicked it.").length > 2, null, { timeout: 20000 }).catch(() => {});
  const text3 = await side.locator("body").innerText();
  check("second risky click on the granted site needs no prompt", text3.split("Clicked it.").length > 2 && !(await grantButton.isVisible().catch(() => false)));

  // Start from the New Tab page, which BrowserHarness cannot read.
  const newTab = await ctx.newPage();
  await newTab.goto("chrome://newtab/").catch(() => {});
  await newTab.bringToFront();
  await side.locator("textarea").first().fill("GOAL_SEARCH go to the search page and search for red shoes");
  await side.getByRole("button", { name: "Send" }).click();
  await side.waitForFunction(() => /SEARCH_OK|SEARCH_FAILED|stopped|failed/i.test(document.body.innerText.split("GOAL_SEARCH").pop() || ""), null, { timeout: 45000 }).catch(() => {});
  const text4 = (await side.locator("body").innerText()).split("GOAL_SEARCH").pop() || "";
  check("a task can start on the New Tab page, survive a bad element id, follow a bare URL and submit with Enter", text4.includes("SEARCH_OK"), text4.slice(-240).replace(/\n/g, " | "));
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} agent checks passed`);
process.exit(failed ? 1 : 0);
