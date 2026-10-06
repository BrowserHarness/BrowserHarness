#!/usr/bin/env node
// Local real-Chromium test of Batch B with a scripted mock model (no real LLM, no network):
// Save as Skill, /skill runs, lessons from failed runs, Skills screen (rename, export, import),
// About me (learned facts, /remember, /forget, Memory screen) and slash commands.
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
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) } }] }));
};

const PAGE = `<html><head><title>Shop</title></head><body>
<h1>Shop</h1>
<form action="/results"><input name="q" aria-label="Search"></form>
</body></html>`;

const prompts = [];
const server = http
  .createServer((req, res) => {
    if (req.url.startsWith("/v1/chat/completions")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw);
        const all = body.messages.map((m) => (Array.isArray(m.content) ? m.content.map((c) => c.text || "").join("") : String(m.content ?? ""))).join("\n");
        prompts.push(all);
        const user = String(body.messages.at(-1).content?.[0]?.text ?? body.messages.at(-1).content ?? "");
        const goal = /USER GOAL:\n([\s\S]*?)\n\nCURRENT PAGE OBSERVATION:/.exec(user)?.[1];
        if (!goal) return reply(res, "CHAT_OK");
        const done = user.split("RECENT EXECUTION EVIDENCE:").pop() || "";
        if (goal.includes("FAIL_THIS")) {
          // Keeps clicking a control that is not there until the agent gives up.
          return reply(res, { kind: "tool", tool: "click", input: { element_id: `@e${900 + prompts.length}` }, note: "Clicking Search" });
        }
        if (goal.includes("GOAL_FLOW") || goal.includes("Use my saved Skill")) {
          const box = /(@e\d+) textbox "Search"/.exec(user)?.[1];
          if (!/\btype[: ]/.test(done) && box) {
            return reply(res, { kind: "tool", tool: "type", input: { element_id: box, text: "red shoes" }, note: "Typing the search" });
          }
          if (!/\bpress_key[: ]/.test(done) && box) {
            return reply(res, { kind: "tool", tool: "press_key", input: { element_id: box, key: "Enter" }, note: "Pressing Enter" });
          }
          return reply(res, { kind: "final", message: goal.includes("Use my saved Skill") ? "SKILL_RUN_OK" : "FLOW_DONE" });
        }
        return reply(res, { kind: "final", message: "TASK_OK" });
      });
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url.startsWith("/results")) return res.end("<html><head><title>Results</title></head><body><h1>Results</h1></body></html>");
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bh-learning-"));
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

  const box = () => side.locator("textarea").first();
  const ask = async (text) => {
    await page.goto(`http://localhost:${port}/`);
    await page.bringToFront();
    await box().fill(text);
    await side.getByRole("button", { name: "Send" }).click();
  };
  const sideText = () => side.locator("body").innerText();
  const waitText = (text, timeout = 20000) =>
    side.waitForFunction((text) => document.body.innerText.includes(text), text, { timeout }).catch(() => {});
  const count = async (text) => (await sideText()).split(text).length - 1;
  const stored = (key) => side.evaluate(async (key) => (await chrome.storage.local.get(key))[key], key);

  // Save as Skill.
  await ask("GOAL_FLOW search this page for red shoes");
  await waitText("FLOW_DONE");
  const saveButton = side.getByRole("button", { name: "Save as Skill" });
  check("a finished multi-step task offers Save as Skill", await saveButton.isVisible().catch(() => false));
  await saveButton.click().catch(() => {});
  await waitText("Saved as a Skill");
  const skills = (await stored("browserharness.skills")) || [];
  const slug = skills[0]?.slug;
  check(
    "the Skill keeps the steps that worked",
    Boolean(slug) && skills[0].instructions.includes("Type “red shoes” into “Search”") && skills[0].instructions.includes("Press Enter"),
    skills[0]?.instructions?.replace(/\n/g, " | ")
  );

  // Slash suggestions.
  await box().fill("/");
  await side.waitForTimeout(200);
  const options = await side.getByRole("option").allInnerTexts();
  check("typing / lists commands and Skills", options.some((text) => text.startsWith("/remember")) && options.some((text) => text.startsWith(`/${slug}`)), options.join(" ; "));
  await box().fill("/rem");
  await box().press("Tab");
  check("Tab completes the command", (await box().inputValue()) === "/remember ");
  await box().fill("");

  // Run the Skill by command.
  const before = prompts.length;
  await ask(`/${slug} size 9`);
  await waitText("SKILL_RUN_OK");
  const runPrompt = prompts.slice(before).find((text) => text.includes("Use my saved Skill")) || "";
  check("/skill-name runs the Skill with its steps and the extra details", runPrompt.includes("Type “red shoes” into “Search”") && runPrompt.includes("This time: size 9"));
  check("a Skill run offers to update the Skill", await side.getByRole("button", { name: "Update the Skill with this run" }).isVisible().catch(() => false));

  // A failed run leaves a lesson the next run reads.
  await ask(`/${slug} FAIL_THIS`);
  await side.waitForFunction(() => !document.querySelector('[aria-label="Stop current task"]'), null, { timeout: 30000 }).catch(() => {});
  await side.waitForTimeout(500);
  const afterFail = ((await stored("browserharness.skills")) || [])[0];
  check(
    "a failed run is counted and leaves a lesson",
    afterFail?.runs === 2 && afterFail?.failures === 1 && /failed actions in a row|same action/i.test(afterFail?.lessons?.[0] || ""),
    JSON.stringify({ runs: afterFail?.runs, failures: afterFail?.failures, lessons: afterFail?.lessons })
  );
  const beforeLesson = prompts.length;
  await ask(`/${slug}`);
  await side.waitForFunction(() => document.body.innerText.split("SKILL_RUN_OK").length > 2, null, { timeout: 20000 }).catch(() => {});
  check("the next run is told the lesson", prompts.slice(beforeLesson).some((text) => text.includes("Lessons from earlier runs")));

  // Skills screen.
  await side.getByRole("button", { name: "Open the menu" }).click();
  await side.getByRole("button", { name: "Skills" }).click();
  await side.getByText("Your Skills").waitFor({ timeout: 5000 }).catch(() => {});
  const card = side.getByTestId("skill-card").first();
  check("the Skills screen shows runs and lessons", /Ran 3 times, worked 2 · 1 lesson learned/.test(await card.innerText().catch(() => "")), await card.innerText().catch(() => ""));
  await card.getByRole("button", { name: /^Rename/ }).click();
  const nameField = side.getByLabel("Skill name");
  await nameField.fill("Find red shoes");
  await nameField.press("Enter");
  await side.waitForTimeout(400);
  check("renaming changes the command too", (await card.innerText()).includes("/find-red-shoes"));
  const download = side.waitForEvent("download", { timeout: 10000 }).catch(() => null);
  await card.getByRole("button", { name: /^Export/ }).click();
  const file = await download;
  const md = file ? fs.readFileSync(await file.path(), "utf8") : "";
  check("Export writes a SKILL.md file", md.startsWith("---\nname: find-red-shoes\n") && md.includes("## Lessons from earlier runs"), md.slice(0, 80));
  const importPath = path.join(profile, "weekly-SKILL.md");
  fs.writeFileSync(importPath, "---\nname: weekly-report\ndescription: Pull the weekly numbers\n---\n\nOpen the dashboard and read the totals.\n");
  await side.getByTestId("skill-import-input").setInputFiles(importPath);
  await waitText("Imported /weekly-report", 5000);
  check("Import adds a SKILL.md file as a Skill", (await side.getByTestId("skill-card").count()) === 2 && (await sideText()).includes("Imported /weekly-report"));
  await side.getByRole("button", { name: "Back to chat" }).first().click();

  // About me.
  await ask("My name is Priya and I prefer window seats. Summarize this page");
  await waitText("TASK_OK");
  check("plain facts in a request are remembered", (await sideText()).includes("Remembered about you: My name is Priya; I prefer window seats"));
  await ask("/remember I live in Pune");
  await waitText("Got it. I'll remember: I live in Pune");
  check("/remember saves a fact", (await sideText()).includes("Got it. I'll remember: I live in Pune"));
  await ask("/remember my password is hunter2");
  await waitText("won't save it");
  check("/remember refuses a password", (await sideText()).includes("won't save it"));
  const beforeMemory = prompts.length;
  await ask("Summarize this page for me");
  await side.waitForFunction(() => document.body.innerText.split("TASK_OK").length > 2, null, { timeout: 20000 }).catch(() => {});
  const memoryPrompt = prompts.slice(beforeMemory).join("\n");
  check("browser tasks get the About me facts", memoryPrompt.includes("ABOUT ME") && memoryPrompt.includes("I live in Pune") && memoryPrompt.includes("My name is Priya"));
  const beforeChat = prompts.length;
  await ask("hi how are you");
  await side.waitForFunction(() => document.body.innerText.includes("CHAT_OK"), null, { timeout: 20000 }).catch(() => {});
  check("chat answers get them too", prompts.slice(beforeChat).some((text) => text.includes("ABOUT ME") && text.includes("I prefer window seats")));
  await ask("/forget pune");
  await waitText("Forgot 1 fact");
  check("/forget removes matching facts", (await sideText()).includes("Forgot 1 fact about “pune”"));

  await side.getByRole("button", { name: "Open the menu" }).click();

  await side.getByRole("button", { name: "About me" }).click();
  await side.getByTestId("about-me-fact").first().waitFor({ timeout: 5000 }).catch(() => {});
  const facts = await side.getByTestId("about-me-fact").allInnerTexts();
  check("the About me screen lists facts, marking learned ones", facts.length === 2 && facts.every((text) => /learned/.test(text)), facts.join(" ; "));
  await side.getByRole("button", { name: "Delete My name is Priya" }).click();
  await side.waitForTimeout(300);
  check("a fact can be deleted there", (await side.getByTestId("about-me-fact").count()) === 1);
  await side.getByRole("button", { name: "Back to chat" }).first().click();

  // Help and unknown commands.
  await ask("/help");
  await waitText("Your Skills:");
  check("/help lists commands and Skills", (await sideText()).includes("/find-red-shoes") && (await sideText()).includes("/weekly-report"));
  await ask("/nope");
  await waitText("There's no command or Skill called /nope");
  check("an unknown command explains itself", (await count("There's no command or Skill called /nope")) === 1);
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} learning checks passed`);
process.exit(failed ? 1 : 0);
