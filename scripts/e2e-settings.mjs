#!/usr/bin/env node
// The grandma-proof Settings: a welcome tab on first install, every page in
// plain words, text size and dark mode, confirmations before deleting, and
// requests handed from the big Settings tab to the side panel's chat.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "apps/extension/dist");
if (!fs.existsSync(path.join(dist, "settings.html"))) {
  console.error("Build first: npm run build");
  process.exit(2);
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const shot = async (page, name, fullPage = true) => {
  if (process.env.SHOT_DIR) await page.screenshot({ path: path.join(process.env.SHOT_DIR, `${name}.png`), fullPage });
};

// From the copy rulebook: words a non-technical person should never meet.
const FORBIDDEN = [/configure/i, /enable functionality/i, /advanced options/i, /integration settings/i, /api endpoint/i, /initiali[sz]e/i, /toggle feature flag/i, /customi[sz]e/i];
const PAGES = [
  ["Start here", "Welcome to BrowserHarness"],
  ["Your AI", "Your AI"],
  ["Safety & approvals", "Safety & approvals"],
  ["About you", "About you"],
  ["Saved Skills", "Saved Skills"],
  ["Scheduled tasks", "Scheduled tasks"],
  ["Task history", "Task history"],
  ["Phone & chat apps", "Phone & chat apps"],
  ["Helper app", "Helper app"],
  ["Learning & memory", "Learning & memory"],
  ["Look & text size", "Look & text size"],
  ["Privacy & your data", "Privacy & your data"],
  ["Help", "Help"]
];

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bh-settings-"));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME || "/opt/pw-browsers/chromium",
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--headless=new", "--no-sandbox"]
});

const errors = [];
ctx.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));

try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const extId = sw.url().split("/")[2];
  const stored = (page, key) => page.evaluate((k) => chrome.storage.local.get(k).then((v) => v[k]), key);

  // 1. First install opens the welcome page.
  const deadline = Date.now() + 10000;
  let welcome = ctx.pages().find((page) => page.url().includes("settings.html"));
  while (!welcome && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    welcome = ctx.pages().find((page) => page.url().includes("settings.html"));
  }
  check("first install opens the welcome page", Boolean(welcome) && welcome.url().endsWith("#home"), welcome?.url());
  const page = welcome || (await ctx.newPage());
  welcome?.on("pageerror", (error) => errors.push(error.message));
  if (!welcome) await page.goto(`chrome-extension://${extId}/settings.html#home`);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("heading", { name: "Welcome to BrowserHarness" }).waitFor({ timeout: 10000 });
  const home = await page.locator("main").innerText();
  check("the welcome page says no AI is connected yet, and step 1 is the only must", home.includes("Not connected yet") && home.includes("The first one is the only one you must do"));
  await shot(page, "settings-home");

  // 2. Every page opens from the list, in plain words.
  const nav = page.getByRole("navigation", { name: "Settings pages" });
  const bad = [];
  for (const [label, heading] of PAGES) {
    await nav.getByRole("button", { name: label, exact: true }).click();
    await page.getByRole("heading", { level: 1, name: heading, exact: true }).waitFor({ timeout: 5000 }).catch(() => bad.push(`${label}: no heading`));
    const text = await page.locator("main").innerText();
    for (const word of FORBIDDEN) if (word.test(text)) bad.push(`${label}: ${word}`);
    await shot(page, `settings-${label.toLowerCase().replace(/[^a-z]+/g, "-").replace(/-$/, "")}`);
  }
  check("all 13 pages open, each with its title and no technical jargon", bad.length === 0, bad.join("; "));
  check("the address remembers the page, so a link can open it", page.url().endsWith("#help"), page.url());

  // 3. Text size and dark mode change right away.
  await nav.getByRole("button", { name: "Look & text size", exact: true }).click();
  const bodySize = () => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector("main p, main .MuiTypography-body1")).fontSize));
  const before = await bodySize();
  await page.getByRole("radio", { name: "Extra large" }).click();
  await page.waitForTimeout(300);
  const after = await bodySize();
  check("Extra large makes the words bigger", after > before, `${before}px → ${after}px`);
  await page.getByRole("radio", { name: "Always dark" }).click();
  await page.waitForTimeout(300);
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check("Always dark turns the page dark", /rgb\((\d{1,2}), (\d{1,2}), (\d{1,2})\)/.test(background), background);
  await shot(page, "settings-look-dark-large");
  const prefs = await stored(page, "browserharness.preferences");
  check("both choices are saved", prefs?.textSize === "larger" && prefs?.appearance === "dark");
  const note = await page.getByTestId("saved-note").innerText().catch(() => "");
  check("a Saved note confirms the change", note.startsWith("Saved"), note);
  await shot(page, "saved-note", false);
  await page.getByRole("radio", { name: "Normal" }).click();
  await page.getByRole("radio", { name: "Same as my computer" }).click();

  // 4. Safety: the risky choice shows its warning; allowed websites ask before removal.
  await page.evaluate(() =>
    chrome.storage.local.set({ "browserharness.siteApprovalGrants.v1": [{ host: "news.example.com", granted_at: new Date().toISOString() }] })
  );
  await nav.getByRole("button", { name: "Safety & approvals", exact: true }).click();
  check("the recommended choice is picked and marked", (await page.getByRole("radio", { name: "Ask me only before important steps" }).getAttribute("aria-checked")) === "true" && (await page.locator("main").innerText()).includes("Recommended"));
  await page.getByRole("radio", { name: "Don't ask me, except for money and passwords" }).click();
  await page.getByText("Please read").waitFor({ timeout: 3000 }).catch(() => {});
  check("the risky choice shows a warning", await page.getByText("Please read").isVisible());
  check("and is saved", (await stored(page, "browserharness.preferences"))?.approvalMode === "auto");
  await shot(page, "settings-safety-warning");
  await page.getByRole("radio", { name: "Ask me only before important steps" }).click();
  await page.getByRole("button", { name: "Stop allowing news.example.com" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ timeout: 3000 });
  await shot(page, "settings-confirm", false);
  await dialog.getByRole("button", { name: "No, keep it" }).click();
  check("No, keep it keeps the website", ((await stored(page, "browserharness.siteApprovalGrants.v1")) || []).length === 1);
  await page.getByRole("button", { name: "Stop allowing news.example.com" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Yes, ask me again" }).click();
  await page.waitForTimeout(300);
  check("confirming removes it", ((await stored(page, "browserharness.siteApprovalGrants.v1")) || []).length === 0);

  // 5. Deleting history asks first.
  await page.evaluate(() =>
    chrome.storage.local.set({
      "browserharness.taskHistory": [{ id: "h1", task: "HIST_TASK find kettles", result: "Three kettles", timestamp: new Date().toISOString() }]
    })
  );
  await nav.getByRole("button", { name: "Learning & memory", exact: true }).click();
  await page.getByLabel("Keep a history of your tasks").click();
  await page.getByRole("dialog").waitFor({ timeout: 3000 });
  check("turning off history asks first", (await page.getByRole("dialog").innerText()).includes("Turn off task history?"));
  await page.getByRole("dialog").getByRole("button", { name: "No, keep it" }).click();
  check("cancelling keeps it on", (await stored(page, "browserharness.preferences"))?.retainTaskHistory !== false);
  await nav.getByRole("button", { name: "Privacy & your data", exact: true }).click();
  await page.getByRole("button", { name: "Delete history" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete history" }).click();
  await page.getByText("Your task history was deleted.").waitFor({ timeout: 3000 }).catch(() => {});
  check("Privacy deletes history after confirming", ((await stored(page, "browserharness.taskHistory")) || []).length === 0);

  // 6. The phone page explains each app with commands to copy.
  await nav.getByRole("button", { name: "Phone & chat apps", exact: true }).click();
  await page.getByRole("radio", { name: "Slack" }).click();
  const phone = await page.locator("main").innerText();
  check("the phone page shows Slack's steps and its command", phone.includes("How to set up Slack") && phone.includes("browserharness-bridge slack setup"));

  // 7. A narrow window shows the list first.
  await page.setViewportSize({ width: 430, height: 900 });
  await page.goto(`chrome-extension://${extId}/settings.html`);
  await page.getByRole("button", { name: /^Your AI/ }).waitFor({ timeout: 5000 });
  check("a narrow window shows the list of pages first", await page.getByRole("button", { name: /^Help Simple answers/ }).isVisible());

  // 8. The side panel has the same Settings, and examples go to its chat.
  const side = await ctx.newPage();
  await side.setViewportSize({ width: 430, height: 1000 });
  await side.goto(`chrome-extension://${extId}/sidepanel.html`);
  await side.getByRole("button", { name: "Settings" }).first().click();
  await side.getByRole("button", { name: /^Start here/ }).waitFor({ timeout: 5000 });
  check("the side panel opens the Settings list with a Bigger button", await side.getByRole("button", { name: "Bigger" }).isVisible());
  await shot(side, "panel-settings-list");
  await side.getByRole("button", { name: /^Look & text size/ }).click();
  await side.getByRole("heading", { name: "Look & text size", level: 1 }).waitFor({ timeout: 5000 });
  await shot(side, "panel-settings-look");
  await side.getByRole("button", { name: "All settings" }).click();
  await side.getByRole("button", { name: "Back to chat" }).click();

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`chrome-extension://${extId}/settings.html#home`);
  await page.getByRole("button", { name: /Find the cheapest flight/ }).click();
  await side.waitForFunction(() => document.querySelector("textarea")?.value.includes("cheapest flight"), null, { timeout: 5000 }).catch(() => {});
  const box = await side.locator("textarea").first().inputValue();
  check("an example in the big tab lands in the side panel's chat box", box.includes("Find the cheapest flight from Delhi to Goa"), box);

  // 9. A failed connection says why, how to fix it, and links its guide.
  await page.goto(`chrome-extension://${extId}/settings.html#ai`);
  await page.getByRole("button", { name: "Show more ways to connect" }).click();
  await page.getByRole("combobox", { name: "Service" }).click();
  await page.getByRole("option", { name: "LM Studio (on this computer)" }).click();
  await page.getByLabel("Server address", { exact: true }).fill("http://localhost:9/v1");
  await page.getByText("Couldn't load the list of models").waitFor({ timeout: 15000 }).catch(() => {});
  check("a server that can't be reached explains why the model list is empty", await page.getByText("Couldn't load the list of models").isVisible());
  await page.getByRole("combobox", { name: "Model name", exact: true }).fill("qwen2.5-7b-instruct");
  await page.getByRole("button", { name: "Test and save", exact: true }).click();
  const failure = page.getByRole("alert").filter({ hasText: /couldn't connect/i });
  await failure.waitFor({ timeout: 30000 }).catch(() => {});
  const failureText = await failure.innerText().catch(() => "");
  check("Test and save shows the reason and the fix", failureText.includes("LM Studio isn't answering") && failureText.includes("Why:") && failureText.includes("How to fix it:"), failureText.split("\n")[1]);
  const guideLink = failure.locator('[data-guide="local-ai-not-running"]');
  const href = (await guideLink.getAttribute("href").catch(() => null)) || "";
  check("its Read the guide button links the matching guide", href.endsWith("settings.html#help/local-ai-not-running"), href);
  await failure.scrollIntoViewIfNeeded().catch(() => {});
  await shot(page, "connect-failed", false);
  const [guideTab] = await Promise.all([ctx.waitForEvent("page", { timeout: 5000 }).catch(() => null), guideLink.click()]);
  const guidePage = guideTab || page;
  await guidePage.setViewportSize({ width: 1280, height: 900 });
  await guidePage.locator('[data-guide-view="local-ai-not-running"]').waitFor({ timeout: 5000 }).catch(() => {});
  const guideText = await guidePage.locator("main").innerText().catch(() => "");
  check("the guide opens with its steps", guideText.includes("How to fix it") && guideText.includes("All help"), guidePage.url());
  await shot(guidePage, "guide-local-ai");
  if (guideTab) await guideTab.close();

  // 10. Help lists every guide, and none uses technical jargon.
  await page.goto(`chrome-extension://${extId}/settings.html#help`);
  await page.locator("[data-guide-link]").first().waitFor({ timeout: 5000 }).catch(() => {});
  const links = await page.locator("[data-guide-link]").evaluateAll((items) => items.map((item) => item.getAttribute("data-guide-link")));
  await shot(page, "help-list");
  const guideProblems = [];
  for (const slug of links) {
    await page.locator(`[data-guide-link="${slug}"]`).first().click();
    await page.locator(`[data-guide-view="${slug}"]`).waitFor({ timeout: 3000 }).catch(() => guideProblems.push(`${slug}: did not open`));
    const text = await page.locator("main").innerText();
    for (const word of FORBIDDEN) if (word.test(text)) guideProblems.push(`${slug}: ${word}`);
    await page.getByRole("button", { name: "All help", exact: true }).click();
    await page.locator("[data-guide-link]").first().waitFor({ timeout: 3000 });
  }
  check(`Help lists ${links.length} guides; each opens and back works, in plain words`, links.length >= 19 && guideProblems.length === 0, guideProblems.join("; "));

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} finally {
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} settings checks passed`);
process.exit(failed ? 1 : 0);
