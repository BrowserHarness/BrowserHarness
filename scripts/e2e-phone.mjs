#!/usr/bin/env node
// Setting up a chat app from Settings, with no terminal: paste a Telegram bot
// token into Settings → Phone & chat apps (a stand-in plays Telegram), see
// a wrong token explained, then allow the person who messaged the bot with one
// press, remove them, and turn the app off.
// Requires: npm run build, npm run build:bridge, playwright-core. Never runs on GitHub Actions.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "apps/extension/dist");
const bundle = path.join(root, "apps/bridge/dist/browserharness-bridge.mjs");
if (![path.join(dist, "manifest.json"), bundle].every((file) => fs.existsSync(file))) {
  console.error("Build first: npm run build && npm run build:bridge");
  process.exit(2);
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const shot = async (page, name) => {
  if (process.env.SHOT_DIR) await page.screenshot({ path: path.join(process.env.SHOT_DIR, `${name}.png`), fullPage: true });
};
const until = async (test, timeoutMs = 15_000) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await test();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return test();
};

// A stand-in for Telegram's Bot API: only the token 123:abc is real.
const telegram = { queue: [], sent: [], nextId: 1 };
const stub = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    const [, token, method] = req.url.match(/^\/tg\/bot([^/]+)\/(\w+)/) || [];
    res.setHeader("content-type", "application/json");
    if (token !== "123:abc") {
      res.statusCode = 401;
      return res.end(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }));
    }
    const answer = (result) => res.end(JSON.stringify({ ok: true, result }));
    if (method === "getMe") return answer({ id: 1, is_bot: true, username: "my_harness_bot" });
    if (method === "sendMessage") {
      telegram.sent.push(body);
      return answer({ message_id: telegram.sent.length });
    }
    if (method === "getUpdates") {
      const deliver = () => answer(telegram.queue.splice(0).filter((update) => update.update_id >= (body.offset || 0)));
      return telegram.queue.length ? deliver() : setTimeout(deliver, 300);
    }
    res.statusCode = 404;
    res.end("{}");
  });
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const message = (userId, name, text) =>
  telegram.queue.push({ update_id: telegram.nextId++, message: { chat: { id: 9000 + userId }, from: { id: userId, first_name: name }, text } });
const replyTo = (chatId, pattern, from = 0) => until(() => telegram.sent.slice(from).find((item) => item.chat_id === chatId && pattern.test(item.text)));

// A person's computer with the helper app, before any chat app is set up.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "bh-phone-home-"));
const port = 11_300 + Math.floor(Math.random() * 500);
const configFile = path.join(home, ".browserharness-bridge", "config.json");
fs.mkdirSync(path.dirname(configFile));
fs.writeFileSync(
  configFile,
  JSON.stringify({
    host: "127.0.0.1",
    port,
    allow_remote: false,
    token: "phone-" + Math.random().toString(36).slice(2),
    telegram: { api_base: `http://127.0.0.1:${stub.address().port}/tg` }
  })
);
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local") };
const helper = (...args) => {
  const run = spawnSync(process.execPath, [bundle, ...args], { env, encoding: "utf8", timeout: 60_000 });
  try {
    return JSON.parse(run.stdout.trim().split("\n").at(-1) || "");
  } catch {
    return { stdout: run.stdout, stderr: run.stderr };
  }
};
const config = () => JSON.parse(fs.readFileSync(configFile, "utf8"));
const daemonPid = () => fs.readFileSync(path.join(home, ".browserharness-bridge", "daemon.pid"), "utf8").trim();

let ctx;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bh-phone-chrome-"));
try {
  check("the helper app starts", helper("start").running === true);
  ctx = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME || "/opt/pw-browsers/chromium",
    headless: false,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--headless=new", "--no-sandbox"]
  });
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const extId = sw.url().split("/")[2];
  const side = await ctx.newPage();
  await side.setViewportSize({ width: 430, height: 1100 });
  await side.goto(`chrome-extension://${extId}/sidepanel.html`);
  await side.evaluate((address) => chrome.storage.local.set({ "browserharness.bridgeSettings": { enabled: false, address, token: "" } }), `ws://127.0.0.1:${port}/ws`);
  await side.reload();
  await side.getByRole("button", { name: "Settings" }).first().click();
  await side.getByRole("button", { name: /^Helper app/ }).click();
  await side.getByRole("button", { name: "Pair", exact: true }).click();
  const code = (await side.getByLabel("Pairing code").innerText({ timeout: 10000 })).replace(/\D/g, "");
  helper("pair", "--code", code, "--json");
  await side.getByText("The helper app is running and paired with this Chrome.").waitFor({ timeout: 15000 });

  await side.goto(`chrome-extension://${extId}/settings.html#phone`);
  // Screenshots hide the scrollbar for a moment; without one the page width
  // (and so where buttons are) stays the same.
  await side.addStyleTag({ content: "::-webkit-scrollbar { display: none; }" });
  const tokenBox = side.getByLabel("Your bot's token");
  await tokenBox.waitFor({ timeout: 10000 });
  const connect = side.getByRole("button", { name: "Connect", exact: true });
  await until(async () => !(await side.getByText("Asking the helper app…").isVisible()));
  check("Telegram is set up with a form, and Connect waits for the token", (await tokenBox.isEnabled()) && (await connect.isDisabled()));
  const pageText = await side.locator("body").innerText();
  check("no terminal step in the setup steps", !/open a terminal/i.test(pageText) && pageText.includes("Commands, for people who use a terminal"));
  await shot(side, "phone-form");

  const pidBefore = daemonPid();
  await tokenBox.fill("123:wrong");
  await connect.click();
  const problem = side.getByRole("alert").filter({ hasText: "didn't accept" });
  await problem.waitFor({ timeout: 15000 }).catch(() => {});
  const problemText = await problem.innerText().catch(() => "");
  check("a wrong token says why and how to get it again", problemText.includes("Telegram didn't accept that code") && problemText.includes("@BotFather"), problemText.slice(0, 160));
  check("a wrong token is not saved", !config().telegram?.token);
  await shot(side, "phone-wrong-token");

  await tokenBox.fill("123:abc");
  await connect.click();
  await side.getByText("Telegram is connected").waitFor({ timeout: 15000 }).catch(() => {});
  const connectedText = await side.locator("body").innerText();
  check("the right token connects, with a tick and the bot's name", connectedText.includes("Telegram is connected") && connectedText.includes("@my_harness_bot"));
  check("the token is saved on this computer", config().telegram?.token === "123:abc" && config().telegram?.bot === "my_harness_bot");
  const status = await side.evaluate(() => chrome.runtime.sendMessage({ type: "BRIDGE_CHAT", action: "status" }));
  check("Settings is never sent the token back", status?.ok === true && !JSON.stringify(status).includes("123:abc"));
  await shot(side, "phone-connected");

  message(7, "Ada", "hi");
  const told = await replyTo(9007, /private/);
  check("a stranger is told how to allow them from Settings", Boolean(told && told.text.includes("Phone & chat apps") && told.text.includes("telegram allow 7")), told?.text);
  const allowAda = side.getByRole("button", { name: "Allow Ada" });
  await allowAda.waitFor({ timeout: 10000 }).catch(() => {});
  check("they appear under People waiting with an Allow button", await allowAda.isVisible());
  await shot(side, "phone-waiting");
  await allowAda.click();
  await side.getByTestId("people-allowed").getByText("Ada").waitFor({ timeout: 10000 }).catch(() => {});
  const savedNote = await side.getByTestId("saved-note").innerText().catch(() => "");
  check("one press allows them, with a confirmation", (await side.getByTestId("people-allowed").getByText("Ada").isVisible()) && savedNote.includes("Ada can use your bot now"), savedNote);
  check("the allowed account and its name are saved", JSON.stringify(config().telegram.allowed_user_ids) === '["7"]' && config().telegram.allowed_names?.["7"] === "Ada");
  check("setting up and allowing don't restart the helper app", daemonPid() === pidBefore);
  await shot(side, "phone-allowed");

  let mark = telegram.sent.length;
  message(7, "Ada", "TG_TASK hello");
  const answered = await until(() => telegram.sent.slice(mark).find((item) => item.chat_id === 9007));
  check("the allowed person's message goes to Chrome, not “private”", Boolean(answered) && !/private/.test(answered.text), answered?.text);

  await side.getByRole("button", { name: "Remove Ada" }).click();
  await side.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
  await until(async () => (await side.getByText("Nobody yet.").isVisible()) || null, 10000);
  check("Remove asks first, then removes them", (await side.getByText("Nobody yet.").isVisible()) && config().telegram.allowed_user_ids.length === 0);
  mark = telegram.sent.length;
  message(7, "Ada", "TG_TASK again");
  check("a removed person is told the bot is private again", Boolean(await replyTo(9007, /private/, mark)));

  await side.getByRole("button", { name: "Turn off Telegram" }).click();
  await side.getByRole("dialog").getByRole("button", { name: "Turn off Telegram" }).click();
  await tokenBox.waitFor({ timeout: 10000 }).catch(() => {});
  check("Turn off asks first, forgets the token and shows the form again", (await tokenBox.isVisible()) && !config().telegram);
  const tile = await side.getByRole("button", { name: /^Telegram: / }).getAttribute("aria-label");
  check("the app list shows Telegram as not set up", tile === "Telegram: Not set up", tile);
} catch (error) {
  check("phone setup e2e ran without crashing", false, error instanceof Error ? error.stack : String(error));
} finally {
  await ctx?.close().catch(() => undefined);
  helper("stop");
  stub.close();
  for (const dir of [home, profile]) fs.rmSync(dir, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} phone setup checks passed`);
process.exit(failed ? 1 : 0);
