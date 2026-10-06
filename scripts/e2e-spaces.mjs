#!/usr/bin/env node
// Local real-Chromium test of Spaces, saved chats and the full-page chat, with a scripted mock
// model (no real LLM, no network): chats are saved and come back after a reload, follow-ups carry
// the earlier turns, a new Space starts empty and keeps its own notes, a chat saves as a file, the
// full-page chat keeps its menu open and never drives its own tab, and the Spaces settings page
// renames, backs up and deletes. Requires: npm run build, playwright-core. Never runs on GitHub Actions.
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
const shots = process.env.SHOT_DIR;
if (shots) fs.mkdirSync(shots, { recursive: true });
const FORBIDDEN = [/configure/i, /enable functionality/i, /advanced/i, /integration/i, /api endpoint/i, /initiali[sz]e/i, /feature flag/i, /customi[sz]e/i];

const reply = (res, content) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) } }] }));
};

const prompts = [];
const server = http
  .createServer((req, res) => {
    if (req.url.startsWith("/v1/chat/completions")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw);
        const all = body.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
        prompts.push(all);
        const user = String(body.messages.at(-1).content?.[0]?.text ?? body.messages.at(-1).content ?? "");
        if (user.startsWith("EXTRACT_FACTS")) return reply(res, "[]");
        const goal = /USER GOAL:\n([\s\S]*?)\n\nCURRENT PAGE OBSERVATION:/.exec(user)?.[1];
        if (goal) {
          return reply(res, { kind: "final", message: user.includes("Kettle shop") ? "AGENT_SAW_WEB_PAGE" : "AGENT_SAW_SOMETHING_ELSE" });
        }
        if (user.includes("EARLIER IN THIS CHAT")) return reply(res, "FOLLOW_UP_OK shorter answer");
        return reply(res, "## Kettles\n\nThe **Philips HD9306** is the cheapest at ₹1,599.");
      });
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end("<html><head><title>Kettle shop</title></head><body><h1>Kettle shop</h1><a href='/k'>Philips</a></body></html>");
  })
  .listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const port = server.address().port;

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bh-spaces-"));
const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "bh-spaces-dl-"));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME || "/opt/pw-browsers/chromium",
  headless: false,
  acceptDownloads: true,
  downloadsPath: downloads,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--headless=new", "--no-sandbox"]
});

const saveDownload = async (page, click) => {
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 10000 }), click()]);
  const file = path.join(downloads, download.suggestedFilename());
  await download.saveAs(file);
  return { name: download.suggestedFilename(), text: fs.readFileSync(file, "utf8") };
};
const jargon = (text) => FORBIDDEN.filter((word) => word.test(text)).map(String);

try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const extId = sw.url().split("/")[2];
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${port}/`);
  const side = await ctx.newPage();
  await side.setViewportSize({ width: 430, height: 1000 });
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

  const waitText = (target, text, timeout = 20000) =>
    target.waitForFunction((text) => document.body.innerText.includes(text), text, { timeout }).catch(() => {});
  const ask = async (target, text) => {
    await target.locator("textarea").first().fill(text);
    await target.getByRole("button", { name: "Send" }).click();
  };
  const openMenu = () => side.getByRole("button", { name: "Open the menu" }).click();
  const closeMenu = () => side.getByRole("button", { name: "Close the menu" }).click();
  const storage = (key) => side.evaluate(async (key) => (await chrome.storage.local.get(key))[key], key);

  // 1. A chat is saved as it happens and comes back after the panel closes.
  await ask(side, "which electric kettle is cheapest?");
  await waitText(side, "Philips HD9306");
  await ask(side, "make it shorter");
  await waitText(side, "FOLLOW_UP_OK");
  const followUp = prompts.at(-1) || "";
  check("a follow-up carries the earlier turns of the chat", followUp.includes("EARLIER IN THIS CHAT") && followUp.includes("Me: which electric kettle is cheapest?") && followUp.includes("Philips HD9306"));
  check("the first request carried no earlier turns", !prompts[0].includes("EARLIER IN THIS CHAT"));
  const saved = (await storage("browserharness.chats")) || [];
  check("the chat is saved in the first Space", saved.length === 1 && saved[0].messages.length === 4 && saved[0].title === "which electric kettle is cheapest?", JSON.stringify(saved.map((c) => c.title)));

  if (shots) await side.screenshot({ path: path.join(shots, "panel-chat.png") });
  await side.reload();
  await side.waitForTimeout(800);
  check("a reload starts a fresh chat", (await side.locator("body").innerText()).includes("Give your browser a task"));
  await openMenu();
  await side.getByTestId("chat-list").getByText("which electric kettle is cheapest?").waitFor({ timeout: 5000 });
  await side.waitForTimeout(400);
  if (shots) await side.screenshot({ path: path.join(shots, "panel-menu.png") });
  check("the menu is in plain words", jargon(await side.locator("nav[aria-label='Chats and Spaces']").innerText()).length === 0);
  await side.getByTestId("chat-list").getByText("which electric kettle is cheapest?").click();
  await waitText(side, "FOLLOW_UP_OK", 5000);
  check("opening a saved chat shows the whole conversation", (await side.locator("body").innerText()).includes("make it shorter"));
  const before = (await storage("browserharness.chats"))[0].updated_at;
  await side.waitForTimeout(300);
  check("just opening a chat doesn't move it up the list", (await storage("browserharness.chats"))[0].updated_at === before);

  // 2. Rename and pin from the chat's menu.
  await openMenu();
  await side.getByRole("button", { name: "More for which electric kettle is cheapest?" }).click();
  await side.getByRole("menuitem", { name: "Rename" }).click();
  await side.getByLabel("Chat name").fill("Kettle shopping");
  await side.getByRole("button", { name: "Save name" }).click();
  await side.getByTestId("chat-list").getByText("Kettle shopping").waitFor({ timeout: 5000 });
  check("a chat can be renamed", (await storage("browserharness.chats"))[0].title === "Kettle shopping");
  await side.getByRole("button", { name: "More for Kettle shopping" }).click();
  await side.getByRole("menuitem", { name: "Pin to the top" }).click();
  await side.waitForTimeout(300);
  check("a chat can be pinned", (await storage("browserharness.chats"))[0].pinned === true);

  // 3. Save the chat as a document and as plain text.
  await side.getByRole("button", { name: "More for Kettle shopping" }).click();
  const doc = await saveDownload(side, () => side.getByRole("menuitem", { name: /Save as a document/ }).click());
  check("a chat saves as a document", doc.name === "kettle-shopping.md" && doc.text.startsWith("# Kettle shopping") && doc.text.includes("## You") && doc.text.includes("Philips HD9306"), doc.name);
  await closeMenu();
  await side.getByRole("button", { name: "Save this chat" }).click();
  const txt = await saveDownload(side, () => side.getByRole("menuitem", { name: /Save as plain text/ }).click());
  check("the open chat saves as plain text from the top bar", txt.name === "kettle-shopping.txt" && txt.text.includes("You:\nmake it shorter"), txt.name);

  // 4. A new Space starts empty and keeps its own notes about you.
  await openMenu();
  await side.getByTestId("space-switcher").click();
  await side.getByRole("menuitem", { name: "New Space" }).click();
  await side.getByLabel("Name of the Space").fill("Work");
  await side.getByRole("button", { name: "Make Space" }).click();
  await waitText(side, "You're in Work", 5000);
  await side.waitForTimeout(400);
  check("a new Space starts with a fresh chat", (await side.locator("body").innerText()).includes("Give your browser a task"));
  check("the top bar shows the Space", (await side.getByTestId("space-chip").innerText()).includes("Work"));
  if (shots) await side.screenshot({ path: path.join(shots, "panel-new-space.png") });
  await ask(side, "/remember I work at Infosys");
  await waitText(side, "I'll remember", 5000);
  const spaces = await storage("browserharness.spaces");
  const work = spaces.spaces.find((space) => space.name === "Work");
  const workFacts = (await storage(`browserharness.aboutMe@${work.id}`)) || [];
  const homeFacts = (await storage("browserharness.aboutMe")) || [];
  check("a fact goes into the Space you're in", workFacts.some((fact) => fact.text === "I work at Infosys") && !homeFacts.some((fact) => /Infosys/.test(fact.text)));
  await openMenu();
  await side.getByTestId("chat-list").getByText("/remember I work at Infosys").waitFor({ timeout: 5000 }).catch(() => {});
  const workList = await side.getByTestId("chat-list").innerText();
  check("the Work Space lists only its own chats", workList.includes("/remember I work at Infosys") && !workList.includes("Kettle shopping"), workList.replace(/\n/g, " | "));
  await closeMenu();
  const beforeWork = prompts.length;
  await ask(side, "suggest a lunch place");
  for (let i = 0; i < 100 && prompts.length === beforeWork; i++) await side.waitForTimeout(100);
  check("requests in Work carry Work's notes", prompts.slice(beforeWork).some((text) => text.includes("I work at Infosys")));

  // 5. Switching back brings back the first Space's chats, without Work's notes.
  await openMenu();
  await side.getByTestId("space-switcher").click();
  await side.getByRole("menuitem", { name: "Personal" }).click();
  await side.getByTestId("chat-list").getByText("Kettle shopping").waitFor({ timeout: 5000 });
  await closeMenu();
  const beforeHome = prompts.length;
  await ask(side, "suggest a dinner place");
  for (let i = 0; i < 100 && prompts.length === beforeHome; i++) await side.waitForTimeout(100);
  check("requests in Personal don't carry Work's notes", prompts.length > beforeHome && !prompts.slice(beforeHome).some((text) => text.includes("Infosys")));

  // 5b. Something said for all Spaces is known in every Space; Work's own notes still stay in Work.
  await ask(side, "/remember Across all Spaces, keep answers concise");
  await waitText(side, "(in every Space)", 5000);
  check("a fact said for all Spaces is kept for every Space", ((await storage("browserharness.aboutMe.global")) || []).some((fact) => fact.text === "Keep answers concise"));
  await openMenu();
  await side.getByTestId("space-switcher").click();
  await side.getByRole("menuitem", { name: "Work" }).click();
  await waitText(side, "You're in Work", 5000);
  await closeMenu();
  const beforeShared = prompts.length;
  await ask(side, "suggest a tea shop");
  for (let i = 0; i < 100 && prompts.length === beforeShared; i++) await side.waitForTimeout(100);
  check("Work gets what was said for all Spaces", prompts.slice(beforeShared).some((text) => text.includes("Keep answers concise") && text.includes("I work at Infosys")));
  await openMenu();
  await side.getByTestId("space-switcher").click();
  await side.getByRole("menuitem", { name: "Personal" }).click();
  await side.getByTestId("chat-list").getByText("Kettle shopping").waitFor({ timeout: 5000 });
  await closeMenu();

  // 6. The full-page chat: the menu stays open, and tasks work in the web page, never in the chat tab.
  const full = await ctx.newPage();
  await full.setViewportSize({ width: 1280, height: 860 });
  await page.bringToFront();
  await full.goto(`chrome-extension://${extId}/chat.html`);
  await full.bringToFront();
  await full.getByTestId("chat-list").getByText("Kettle shopping").waitFor({ timeout: 8000 });
  check("the full page shows the menu of chats", await full.getByTestId("space-switcher").isVisible());
  await full.getByTestId("chat-list").getByText("Kettle shopping").click();
  await waitText(full, "FOLLOW_UP_OK", 5000);
  if (shots) await full.screenshot({ path: path.join(shots, "full-page-chat.png") });
  await full.getByRole("button", { name: "New chat" }).first().click();
  await waitText(full, "Give your browser a task", 5000);
  if (shots) await full.screenshot({ path: path.join(shots, "full-page-new.png") });
  await ask(full, "click the Philips link on this page");
  await waitText(full, "AGENT_", 30000);
  const fullText = await full.locator("body").innerText();
  check("a task from the full page works in the web page", fullText.includes("AGENT_SAW_WEB_PAGE"), fullText.match(/AGENT_\w+/)?.[0]);
  check("the full-page chat never drives its own tab", full.url().endsWith("/chat.html"));
  check("the full page is in plain words", jargon(fullText).length === 0);

  // 7. Settings → Spaces: rename, back up, bring back, delete.
  await full.goto(`chrome-extension://${extId}/settings.html#spaces`);
  await full.getByTestId("space-row").first().waitFor({ timeout: 8000 });
  if (shots) await full.screenshot({ path: path.join(shots, "settings-spaces.png"), fullPage: true });
  check("the Spaces page is in plain words", jargon(await full.locator("main").innerText()).length === 0);
  const workRow = full.getByTestId("space-row").filter({ hasText: "Work" });
  await workRow.getByRole("button", { name: "Rename" }).click();
  await full.getByLabel("Name of the Space").fill("Office");
  await full.getByRole("button", { name: "Save name" }).click();
  await full.getByTestId("space-row").filter({ hasText: "Office" }).waitFor({ timeout: 5000 });
  check("a Space can be renamed", (await storage("browserharness.spaces")).spaces.some((space) => space.name === "Office"));
  const office = full.getByTestId("space-row").filter({ hasText: "Office" });
  const backup = await saveDownload(full, () => office.getByRole("button", { name: "Save a backup" }).click());
  const parsed = JSON.parse(backup.text);
  check("a Space saves as a backup file", parsed.kind === "browserharness-space-backup" && parsed.space.name === "Office" && JSON.stringify(parsed.data).includes("Infosys"), backup.name);
  await office.getByRole("button", { name: "Delete" }).click();
  await full.getByRole("button", { name: "Delete Space" }).click();
  await full.getByTestId("space-row").filter({ hasText: "Office" }).waitFor({ state: "detached", timeout: 5000 });
  const keysLeft = await side.evaluate(async (id) => Object.keys(await chrome.storage.local.get(null)).filter((key) => key.endsWith(`@${id}`)), work.id);
  check("deleting a Space removes everything it kept", keysLeft.length === 0, keysLeft.join(", "));
  const file = path.join(downloads, backup.name);
  await full.getByTestId("restore-input").setInputFiles(file);
  await waitText(full, "Brought back as", 5000);
  const restored = (await storage("browserharness.spaces")).spaces.find((space) => space.name === "Office");
  const restoredFacts = restored ? (await storage(`browserharness.aboutMe@${restored.id}`)) || [] : [];
  check("a backup comes back as a Space with its notes", restoredFacts.some((fact) => fact.text === "I work at Infosys"));
  if (shots) await full.screenshot({ path: path.join(shots, "settings-spaces-restored.png"), fullPage: true });
} catch (error) {
  check("spaces e2e ran without crashing", false, error instanceof Error ? error.stack : String(error));
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(downloads, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
