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
        if (user.includes("Rewrite the browser-task request below")) {
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Open the current page and report its main heading." } }] }));
        }
        const isWorker = user.includes("WORKER SUBTASK:");
        modelCalls.push(isWorker ? "worker" : "main");
        if (isWorker) {
          if (user.includes("independent read-only VERIFIER")) {
            return reply(res, { kind: "final", message: "VERDICT: supported. Checked the page title myself." });
          }
          return reply(res, { kind: "final", message: "Claim: the page is titled Mock Page." });
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
    res.end("<html><head><title>Mock Page</title></head><body><h1>hello mock</h1></body></html>");
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
        "browsercrew.providerConnections": [connection],
        "browsercrew.runtimeRouting": { primaryConnectionId: connection.id }
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
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} agent checks passed`);
process.exit(failed ? 1 : 0);
