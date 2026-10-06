#!/usr/bin/env node
// Local real-Chromium test of Batch C with a scripted mock model (no real LLM, no network):
// /schedule, the Scheduled tab, alarms that fire a missed run in its own background tab,
// results in history and notifications, and "needs you" stops for risky steps.
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

const server = http
  .createServer((req, res) => {
    if (req.url.startsWith("/v1/chat/completions")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw);
        const user = String(body.messages.at(-1).content?.[0]?.text ?? body.messages.at(-1).content ?? "");
        const goal = /USER GOAL:\n([\s\S]*?)\n\nCURRENT PAGE OBSERVATION:/.exec(user)?.[1] || "";
        const done = user.split("RECENT EXECUTION EVIDENCE:").pop() || "";
        if (goal.includes("GOAL_SCHED") || goal.includes("GOAL_RISKY")) {
          if (!/\bnavigate[: ]/.test(done)) {
            return reply(res, { kind: "tool", tool: "navigate", input: { url: `http://localhost:${port}/shop` }, note: "Opening the shop" });
          }
          if (goal.includes("GOAL_RISKY") && !/\bclick[: ]/.test(done)) {
            const id = /(@e\d+) button "Delete item"/.exec(user)?.[1];
            return reply(res, { kind: "tool", tool: "click", input: { element_id: id }, note: "Deleting the item" });
          }
          const heading = /Shop heading \w+/.exec(user)?.[0] || "no heading";
          return reply(res, { kind: "final", message: `SCHED_DONE ${heading}` });
        }
        return reply(res, { kind: "final", message: "OK" });
      });
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url.startsWith("/shop")) {
      return res.end(`<html><head><title>Shop</title></head><body><h1>Shop heading Alpha</h1>
<button onclick="this.textContent='Item deleted'">Delete item</button></body></html>`);
    }
    res.end("<html><head><title>My work</title></head><body><h1>The page I am using</h1></body></html>");
  })
  .listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const port = server.address().port;

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bh-automation-"));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME || "/opt/pw-browsers/chromium",
  headless: false,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--headless=new", "--no-sandbox"]
});

try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const extId = sw.url().split("/")[2];
  const work = await ctx.newPage();
  await work.goto(`http://localhost:${port}/`);
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
    await work.bringToFront();
    await box().fill(text);
    await side.getByRole("button", { name: "Send" }).click();
  };
  const sideText = () => side.locator("body").innerText();
  const stored = (key) => side.evaluate(async (key) => (await chrome.storage.local.get(key))[key], key);
  const alarms = () => side.evaluate(() => chrome.alarms.getAll());
  const until = async (fn, timeout, step = 500) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = await fn();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, step));
    }
    return null;
  };

  // /schedule in plain words sets a schedule and an alarm.
  await ask("/schedule every weekday at 8am check the shop for new items");
  await side.getByText("Scheduled:", { exact: false }).first().waitFor({ timeout: 10000 }).catch(() => {});
  const schedules = (await stored("browserharness.schedules")) || [];
  const weekday = schedules[0];
  const next = weekday ? new Date(weekday.next_run_at) : null;
  check(
    "/schedule understands 'every weekday at 8am'",
    weekday?.task === "check the shop for new items" && next?.getHours() === 8 && next.getDay() >= 1 && next.getDay() <= 5,
    JSON.stringify(weekday)
  );
  const alarm = await until(async () => (await alarms()).find((item) => item.name.endsWith(weekday?.id)), 5000);
  check("a Chrome alarm is set for its next run", Math.abs((alarm?.scheduledTime || 0) - next?.getTime()) < 2000);
  await ask("/schedule whenever check things");
  await side.getByText("couldn't tell when").waitFor({ timeout: 5000 }).catch(() => {});
  check("an unclear time gets a helpful answer", (await sideText()).includes("I couldn't tell when to run it"));

  // A run missed while Chrome was closed catches up in its own background tab.
  const missedId = "missed-run";
  await side.evaluate(
    ([id, url]) =>
      chrome.storage.local.get("browserharness.schedules").then((stored) =>
        chrome.storage.local.set({
          "browserharness.schedules": [
            {
              id,
              task: `GOAL_SCHED open ${url} and tell me the heading`,
              schedule: { kind: "daily", time: "07:00", days: [0, 1, 2, 3, 4, 5, 6] },
              enabled: true,
              created_at: new Date().toISOString(),
              next_run_at: new Date(Date.now() - 60_000).toISOString()
            },
            ...(stored["browserharness.schedules"] || [])
          ]
        })
      ),
    [missedId, `http://localhost:${port}/shop`]
  );
  await work.bringToFront();
  const ran = await until(
    async () => ((await stored("browserharness.schedules")) || []).find((item) => item.id === missedId && item.last_status),
    90_000,
    1000
  );
  check("a missed run fires and finishes on its own", ran?.last_status === "worked" && ran.last_result.includes("SCHED_DONE Shop heading Alpha"), JSON.stringify(ran?.last_result || ran));
  check("the next run moves to tomorrow", ran && new Date(ran.next_run_at) > new Date() && new Date(ran.next_run_at).getHours() === 7);
  const workStillActive = await work.evaluate(() => document.visibilityState === "visible" && location.pathname === "/");
  check("it never took over the page you were using", workStillActive);
  const shopTab = ctx.pages().find((p) => p.url().includes("/shop"));
  check("it worked in its own background tab", Boolean(shopTab));
  const history = (await stored("browserharness.taskHistory")) || [];
  check("the result is in history", history.some((entry) => entry.task.startsWith("Scheduled: GOAL_SCHED") && entry.result.includes("SCHED_DONE")));
  const notified = await side.evaluate(() => new Promise((resolve) => chrome.notifications.getAll((all) => resolve(Object.keys(all)))));
  check("a notification says it finished", notified.some((id) => id.startsWith(`browserharness-run:${missedId}`)), notified.join(","));

  // Risky steps wait for the person.
  await side.evaluate(
    ([url]) =>
      chrome.storage.local.get("browserharness.schedules").then((stored) =>
        chrome.storage.local.set({
          "browserharness.schedules": [
            {
              id: "risky-run",
              task: `GOAL_RISKY open ${url} and delete the item`,
              schedule: { kind: "daily", time: "07:00", days: [0, 1, 2, 3, 4, 5, 6] },
              enabled: true,
              created_at: new Date().toISOString(),
              next_run_at: new Date(Date.now() + 86_400_000).toISOString()
            },
            ...(stored["browserharness.schedules"] || [])
          ]
        })
      ),
    [`http://localhost:${port}/shop`]
  );
  await side.getByRole("button", { name: "Open the menu" }).click();
  await side.getByRole("button", { name: "Task history" }).click();
  await side.getByRole("tab", { name: "Scheduled" }).click();
  const riskyCard = side.getByTestId("scheduled-task").filter({ hasText: "GOAL_RISKY" });
  const runnerOpened = ctx.waitForEvent("page", { timeout: 10000 }).catch(() => null);
  await riskyCard.getByRole("button", { name: "Run now" }).click();
  const runner = await runnerOpened;
  await runner?.getByText(/^Needs you/).waitFor({ timeout: 30000 }).catch(() => {});
  const risky = ((await stored("browserharness.schedules")) || []).find((item) => item.id === "risky-run");
  check("Run now works, and a risky step stops with 'needs you'", risky?.last_status === "needs you" && /Delete item/.test(risky.last_result), risky?.last_result);
  const deleted = await Promise.all(ctx.pages().map((p) => p.locator("text=Item deleted").count().catch(() => 0)));
  check("the risky click was not made", deleted.every((count) => count === 0));
  await side.bringToFront();
  await side.waitForTimeout(500);
  check("the Scheduled tab shows the outcome", (await riskyCard.innerText()).includes("needs you"));

  // The Scheduled tab's form, switch and delete.
  await side.getByLabel("What should it do?").fill("FORM_TASK read my dashboard");
  await side.getByRole("button", { name: "Schedule it" }).click();
  const formCard = side.getByTestId("scheduled-task").filter({ hasText: "FORM_TASK" });
  await formCard.waitFor({ timeout: 5000 }).catch(() => {});
  check("the form schedules a task (every weekday at 8 by default)", /Every weekday at 8:00/.test(await formCard.innerText().catch(() => "")));
  await formCard.getByRole("checkbox").click();
  await side.waitForTimeout(400);
  const formItem = ((await stored("browserharness.schedules")) || []).find((item) => item.task.startsWith("FORM_TASK"));
  const formAlarm = (await alarms()).find((item) => item.name.endsWith(formItem?.id));
  check("turning it off removes its alarm", formItem?.enabled === false && !formAlarm && (await formCard.innerText()).includes("· turned off"));
  await formCard.getByRole("button", { name: /^Delete scheduled task/ }).click();
  await side.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await side.waitForTimeout(400);
  check("it can be deleted", (await side.getByTestId("scheduled-task").filter({ hasText: "FORM_TASK" }).count()) === 0);

  // Notification clicks open this tab.
  const fromNotification = await ctx.newPage();
  await fromNotification.goto(`chrome-extension://${extId}/sidepanel.html?view=scheduled`);
  await fromNotification.getByRole("tab", { name: "Scheduled", selected: true }).waitFor({ timeout: 5000 }).catch(() => {});
  check("?view=scheduled opens the Scheduled tab", (await fromNotification.getByRole("tab", { name: "Scheduled", selected: true }).count()) === 1);
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} automation checks passed`);
process.exit(failed ? 1 : 0);
