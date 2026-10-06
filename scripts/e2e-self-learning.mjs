#!/usr/bin/env node
// Local real-Chromium test of smarter learning with a scripted mock model (no real LLM, no network):
// a finished multi-step task becomes a Skill on its own, a similar request follows it, a shorter
// run improves it, a failed run teaches it a lesson, and the person can undo, keep or turn it off.
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

const PAGE = `<html><head><title>Tea Shop</title></head><body>
<h1>Tea Shop</h1>
<input aria-label="Search">
<button>Add to cart</button>
<input aria-label="Email"><button>Next</button><button>Done</button>
</body></html>`;

const prompts = [];
const calls = new Map();
const server = http
  .createServer((req, res) => {
    if (req.url.startsWith("/v1/chat/completions")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw);
        const user = String(body.messages.at(-1).content?.[0]?.text ?? body.messages.at(-1).content ?? "");
        prompts.push(body.messages.map((m) => String(typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"));
        const goal = /USER GOAL:\n([\s\S]*?)\n\nCURRENT PAGE OBSERVATION:/.exec(user)?.[1];
        if (!goal) return reply(res, "CHAT_OK");
        const ref = (pattern) => new RegExp(`(@e\\d+) ${pattern}`).exec(user)?.[1];
        const request = goal.split("\n")[0];
        if (request.includes("FAIL_THIS")) {
          return reply(res, { kind: "tool", tool: "click", input: { element_id: `@e${900 + prompts.length}` }, note: "Clicking" });
        }
        // One decision per model call, in order, for each request.
        const step = (calls.get(request) || 0) + 1;
        calls.set(request, step);
        if (request.includes("newsletter")) {
          const plan = [
            { kind: "tool", tool: "type", input: { element_id: ref('textbox "Email"'), text: "ada@example.com" }, note: "Typing" },
            { kind: "tool", tool: "click", input: { element_id: ref('button "Next"') }, note: "Next" },
            { kind: "tool", tool: "click", input: { element_id: ref('button "Done"') }, note: "Done" }
          ];
          return reply(res, plan[step - 1] || { kind: "final", message: "NEWS_DONE" });
        }
        const tea = /for (\w+ tea)/.exec(request)?.[1];
        if (tea) {
          const plan = [
            { kind: "tool", tool: "type", input: { element_id: ref('textbox "Search"'), text: tea }, note: "Typing" },
            { kind: "tool", tool: "press_key", input: { element_id: ref('textbox "Search"'), key: "Enter" }, note: "Enter" },
            { kind: "tool", tool: "click", input: { element_id: ref('button "Add to cart"') }, note: "Adding" }
          ];
          return reply(res, plan[step - 1] || { kind: "final", message: `CART_DONE ${tea}` });
        }
        return reply(res, { kind: "final", message: "TASK_OK" });
      });
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bh-self-learning-"));
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
        "browserharness.runtimeRouting": { primaryConnectionId: connection.id }
      }),
    connection
  );
  await side.reload();
  await side.waitForTimeout(800);

  const box = () => side.locator("textarea").first();
  const idle = () => side.waitForFunction(() => !document.querySelector('[aria-label="Stop current task"]'), null, { timeout: 30000 }).catch(() => {});
  const ask = async (text) => {
    await page.goto(`http://localhost:${port}/`);
    await page.bringToFront();
    await box().fill(text);
    await side.getByRole("button", { name: "Send" }).click();
    await side.waitForTimeout(300);
    await idle();
    await side.waitForTimeout(400);
  };
  const sideText = () => side.locator("body").innerText();
  const skills = () => side.evaluate(async () => (await chrome.storage.local.get("browserharness.skills"))["browserharness.skills"] || []);

  // 1. A finished multi-step task becomes a Skill without pressing anything.
  await ask("search the tea shop for green tea and add it to the cart");
  let saved = await skills();
  const learned = saved[0];
  if (process.env.DEBUG) console.log((await sideText()).slice(-1500));
  check(
    "a finished multi-step task is learned as a Skill on its own",
    saved.length === 1 && learned.source === "auto" && (await sideText()).includes(`Learned this as /${learned.slug}`),
    JSON.stringify(saved.map((skill) => skill.slug))
  );
  check(
    "the learned steps take the request's words as an input",
    learned?.instructions.includes("Type what I ask for (last time “green tea”) into “Search”") && learned.instructions.includes("Click “Add to cart”"),
    learned?.instructions.replace(/\n/g, " | ")
  );
  check("Save as Skill is not offered again for it", !(await side.getByRole("button", { name: "Save as Skill" }).isVisible().catch(() => false)));

  // 2. A similar request follows the Skill.
  const before = prompts.length;
  await ask("search the tea shop for black tea and add it to the cart");
  const hinted = prompts.slice(before).find((text) => text.includes("A SAVED SKILL MAY HELP")) || "";
  check("a similar request gets the Skill as a guide", hinted.includes(`/${learned.slug}`));
  check("the agent still uses this request's values", (await sideText()).includes("CART_DONE black tea"));
  saved = await skills();
  check("the run is counted for the Skill, and no duplicate is learned", saved.length === 1 && saved[0].runs === 1 && saved[0].successes === 1, JSON.stringify(saved.map((s) => [s.slug, s.runs, s.successes])));

  // 3. A shorter way updates the Skill.
  await side.evaluate(async () => {
    const all = (await chrome.storage.local.get("browserharness.skills"))["browserharness.skills"];
    all[0].instructions = all[0].instructions.replace(/^1\. /m, "1. Click “Menu”\n1. ").replace(/^(\d+)\. /gm, (_m, n, offset, text) => `${text.slice(0, offset).split("\n").filter((l) => /^\d+\. /.test(l)).length + 1}. `);
    await chrome.storage.local.set({ "browserharness.skills": all });
  });
  await ask("search the tea shop for white tea and add it to the cart");
  saved = await skills();
  check(
    "a run with fewer steps updates the Skill",
    (await sideText()).includes(`Found a shorter way and updated /${learned.slug}`) && !saved[0].instructions.includes("Menu") && saved[0].runs === 2,
    saved[0]?.instructions.replace(/\n/g, " | ")
  );

  // 4. A failed run teaches the Skill a lesson.
  await ask("search the tea shop for FAIL_THIS tea and add it to the cart");
  saved = await skills();
  check("a failed run leaves a lesson on the Skill", saved[0].failures === 1 && saved[0].lessons.length === 1, JSON.stringify(saved[0].lessons));

  // 5. Undo forgets a Skill learned by mistake.
  await ask("in the tea shop subscribe me to the newsletter");
  const news = (await skills()).find((skill) => skill.source === "auto" && skill.instructions.includes("Email"));
  check("another kind of task is learned as its own Skill", Boolean(news) && (await sideText()).includes("NEWS_DONE"), JSON.stringify((await skills()).map((s) => s.slug)));
  await side.getByRole("button", { name: "Undo" }).last().click();
  await side.waitForTimeout(300);
  check("Undo forgets it", !(await skills()).some((skill) => skill.id === news?.id) && (await sideText()).includes(`Forgot /${news?.slug}`));

  // 6. The Skills screen marks it, Keep makes it the person's own, and learning can be turned off.
  await side.getByRole("button", { name: "Skills" }).click();
  await side.getByText("Learned on its own").first().waitFor({ timeout: 5000 });
  check("the Skills screen marks Skills learned on their own", true);
  if (process.env.SHOT_DIR) await side.screenshot({ path: path.join(process.env.SHOT_DIR, "self-learning-skills.png"), fullPage: true });
  await side.getByRole("button", { name: "Keep" }).first().click();
  await side.waitForTimeout(300);
  check("Keep makes it a normal Skill", (await skills())[0].source === "chat" && !(await side.getByText("Learned on its own").isVisible().catch(() => false)));
  await side.getByLabel(/Learn Skills on my own/).uncheck();
  await side.getByRole("button", { name: "Back to chat" }).first().click();
  const beforeOff = prompts.length;
  await ask("search the tea shop for oolong tea and add it to the cart");
  check(
    "with learning off, no Skill is followed or learned",
    !prompts.slice(beforeOff).some((text) => text.includes("A SAVED SKILL MAY HELP")) && (await skills()).length === 1,
    JSON.stringify({ hinted: prompts.slice(beforeOff).map((text) => text.slice(Math.max(0, text.indexOf("A SAVED SKILL MAY HELP") - 400), text.indexOf("A SAVED SKILL MAY HELP") + 60)).find((t, i) => prompts.slice(beforeOff)[i].includes("A SAVED SKILL MAY HELP")), skills: (await skills()).map((s) => s.slug) })
  );
  if (process.env.SHOT_DIR) await side.screenshot({ path: path.join(process.env.SHOT_DIR, "self-learning-chat.png"), fullPage: true });
} catch (error) {
  check("self-learning e2e ran without crashing", false, error instanceof Error ? error.stack : String(error));
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} self-learning checks passed`);
process.exit(failed ? 1 : 0);
