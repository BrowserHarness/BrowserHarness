#!/usr/bin/env node
// Automated acceptance of Watch Me and signed-out reads, in real Chromium with
// the built extension and Bridge, driven through the person's real side panel
// (its Record and Finish buttons): the RC4 real-site failures, on local
// stand-ins. A product tab in use for a while (hundreds of earlier requests),
// a task that last used another tab, a closed tab, a sign-in typed while
// recording, and a signed-in account read run after signing out.
// No AI model, no internet. Requires: npm run build, npm run build:bridge,
// playwright-core. Never runs on GitHub Actions.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { startHarness, root } from "./lib/api-engine-harness.mjs";

const require = createRequire(import.meta.url);
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const clip = (value, size = 400) => String(typeof value === "string" ? value : JSON.stringify(value)).slice(0, size);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (test, ms = 15000) => {
  for (let waited = 0; waited < ms; waited += 200) {
    if (await test()) return true;
    await sleep(200);
  }
  return false;
};

// what the person types while signing in: none of it may be kept anywhere
const EMAIL = "ada.lovelace.rc5@example.org";
const PASSWORD = "Hunter2-Secret-9931!";
const CODE = "482913";
const FULL_NAME = "Augusta Ada King";
const SECRETS = [EMAIL, PASSWORD, CODE, FULL_NAME, encodeURIComponent(EMAIL)];

let harness;
let cdp;
try {
  harness = await startHarness({ check, title: "Watch Me acceptance" });
  const { ctx, side, shop, command, debugPort, inSidePanel, home } = harness;
  const status = async () => (await side.evaluate(() => chrome.runtime.sendMessage({ type: "WATCH_STATUS" })))?.data || {};
  const tabIdOf = (prefix) => side.evaluate(async (start) => (await chrome.tabs.query({})).find((tab) => tab.url?.startsWith(start))?.id, prefix);
  const badge = () => side.evaluate(() => chrome.action.getBadgeText({}));

  await inSidePanel("1");
  const { chromium } = require("playwright-core");
  cdp = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  let panel;
  for (const page of cdp.contexts().flatMap((context) => context.pages())) {
    if (!page.url().endsWith("/sidepanel.html")) continue;
    const inTab = await page.evaluate(() => new Promise((resolve) => chrome.tabs.getCurrent((tab) => resolve(Boolean(tab)))));
    if (!inTab) panel = page;
  }
  if (!panel) throw new Error("the real side panel was not found");
  const panelText = () => panel.locator("body").innerText();
  /** Each part runs on its own: one defect does not hide the others. */
  const section = async (name, run) => {
    try {
      await run();
    } catch (error) {
      check(`${name}: ran to the end`, false, clip(error instanceof Error ? error.stack : error, 600));
    }
  };
  const record = async () => {
    await panel.getByRole("button", { name: "Record workflow" }).click({ timeout: 5000 });
    return until(async () => (await status()).recording === true, 8000);
  };
  /**
   * Records `page` the person's way, with the panel's Record button. If that
   * records another tab (or nothing), the recording is started on the page
   * directly instead, as the RC4 run had to, so the later checks still run.
   */
  const recordOn = async (page) => {
    const want = await side.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id, page.url());
    const viaPanel = (await record().catch(() => false)) && (await status()).root_tab_id === want;
    if (!viaPanel) {
      if ((await status()).recording) await side.evaluate(() => chrome.runtime.sendMessage({ type: "WATCH_STOP" }));
      await side.evaluate((id) => chrome.runtime.sendMessage({ type: "WATCH_START", tab_id: id }), want);
    }
    return { viaPanel, status: await status() };
  };
  // Finish, then wait for the panel's answer: the capture is kept by then
  const answers = async () => ((await panelText()).match(/Saved “Workflow|Recording stopped\./g) || []).length;
  const finish = async () => {
    const before = await answers();
    const button = panel.getByRole("button", { name: "Finish recording" }).first();
    if (!(await button.isVisible().catch(() => false))) {
      // started directly: stopped directly
      const stopped = await side.evaluate(() => chrome.runtime.sendMessage({ type: "WATCH_STOP" }));
      return Boolean(stopped?.ok);
    }
    await button.click();
    return until(async () => (await status()).recording === false && (await answers()) > before, 20000);
  };

  let product;
  let active = {};
  await section("the tab in front", async () => {
    // ------------------------------------------------------------ R5-2: the tab in front, not the task's
    // the product tab has been in use for a while with its network recorded
    // (RC4: earlier commands had started a capture; the shop's analytics then
    // sent hundreds of requests before Record)
    const used = await command("task", "open_tab", { url: `${shop.origin}/products/akshat`, observe: false });
    await command("task", "network", { action: "start" });
    await command("task", "navigate", { url: `${shop.origin}/products/akshat?busy=480`, observe: false });
    product = ctx.pages().find((page) => page.url().startsWith(`${shop.origin}/products/akshat`));
    await product.locator("#busy").filter({ hasText: "sent 480" }).waitFor({ timeout: 30000 });
    // then a task used another tab last (RC4: the account tab of the orders command)
    const task = await command("task", "open_tab", { url: `${shop.origin}/search?q=laptops`, observe: false });
    check("the product tab was used (480 requests recorded) and a task then opened another tab", used.ok && task.ok, clip(used.error || task.error));
    // the person looks at the product tab
    await product.bringToFront();
    const followed = await until(async () => /On: Akshat/.test(await panelText()), 8000);
    check("the panel follows the tab in front", followed, clip((await panelText()).slice(0, 200)));

    const started = await recordOn(product);
    active = started.status;
    check(
      "Record records the product tab the person is looking at, not the task's tab",
      started.viaPanel && active.root_tab_id === (await tabIdOf(`${shop.origin}/products/akshat`)),
      clip(active)
    );

    // ------------------------------------------------------------ R5-5: unmistakable while recording
    check("the toolbar icon says REC while recording", await until(async () => (await badge()) === "REC", 5000), await badge());
    check(
      "the recorded page shows that it is being recorded",
      await until(async () => (await product.locator("#browserharness-recording-banner").count()) === 1, 5000)
    );
    const bar = panel.getByRole("status", { name: "Recording in progress" });
    check("the panel shows a recording bar naming the tab, with Finish", (await bar.isVisible()) && /Akshat/.test(await bar.innerText()), clip(await bar.innerText().catch(() => "")));

  });

  await section("the demonstration on a used tab", async () => {
    // ------------------------------------------------------------ R5-1: the demonstration on a used tab
    await product.locator("#add").click();
    await product.locator("#done").filter({ hasText: "Added" }).waitFor({ timeout: 10000 });
    await sleep(1500);
    const recordingId = active.recording_id;
    check("Finish recording stops it", await finish());
    check("the REC badge and the page note go away", (await badge()) === "" && (await product.locator("#browserharness-recording-banner").count()) === 0);
    check("the demonstration added to the cart once", shop.state.cartAdds === 1, `${shop.state.cartAdds} adds`);

    const learned = await command("learn-api", "site_skill", {
      action: "learn_api",
      name: "add_to_cart",
      skill_name: "Watch Me stand-in",
      from_watch: [recordingId],
      side_effect: "write",
      pick_request: `POST ${shop.origin}/cart/add`
  });
  check(
    "the Add to cart demonstrated on a used tab is learned (RC4: dropped with the oldest 400 kept)",
    learned.ok && learned.data?.contract?.request?.url === `${shop.origin}/cart/add` && learned.data?.contract?.target?.label === "Akshat (Rice)",
    clip(learned.error || learned.data?.operation)
  );
  check("learning sent nothing", shop.state.cartAdds === 1);
  await product.evaluate(() => fetch("/cart/clear.js", { method: "POST" }));

  });

  await section("a closed tab", async () => {
    // ------------------------------------------------------------ R5-6: a closed tab is not kept
    const passing = await ctx.newPage();
    await passing.goto(`${shop.origin}/token-search`);
    await passing.bringToFront();
    await until(async () => /On: Records/.test(await panelText()), 8000);
    await passing.close();
    const moved = await until(async () => !/On: Records/.test(await panelText()), 8000);
    check("the panel lets go of a closed tab", moved, clip((await panelText()).slice(0, 200)));
    const restarted = await record();
    const after = await status();
    const exists = await side.evaluate(async (id) => Boolean(await chrome.tabs.get(id).catch(() => null)), after.root_tab_id ?? -1);
    check(
      "Record after a tab closed records an open tab, no 'No tab with id'",
      restarted && exists && !/No tab with id/.test(await panelText()),
      clip({ after, tail: (await panelText()).slice(-300) })
    );
    await finish();
  });

  await section("sign-in typed while recording", async () => {
    // ------------------------------------------------------------ R5-5: sign-in typed while recording
    const login = await ctx.newPage();
    await login.goto(`${shop.origin}/account/login`);
    await login.bringToFront();
    await until(async () => /On: Sign in/.test(await panelText()), 8000);
    const signInStart = await recordOn(login);
    check("a recording can start on the sign-in page", signInStart.viaPanel, clip(signInStart.status));
    const signInRecording = signInStart.status.recording_id;
    await login.locator("#email").pressSequentially(EMAIL, { delay: 5 });
    await login.locator("#password").pressSequentially(PASSWORD, { delay: 5 });
    await login.locator("#code").pressSequentially(CODE, { delay: 5 });
    await login.locator("#fullname").pressSequentially(FULL_NAME, { delay: 5 });
    await login.locator("#signin").click();
    // signed in, the site goes on to the account page, as Shopify's does
    await login.waitForURL(`${shop.origin}/my-account`, { timeout: 10000 });
    await login.locator("#orders li").first().waitFor({ timeout: 10000 });
    await sleep(800);
    const during = JSON.stringify(await side.evaluate(() => chrome.storage.session.get(null)));
    const heldDuring = SECRETS.filter((value) => during.includes(value));
    check("while recording, the recording holds nothing typed while signing in", heldDuring.length === 0, heldDuring.length ? `found ${heldDuring.length} value(s)` : "");
    check("Finish recording stops the sign-in recording", await finish());
    await sleep(500);

    const stored = JSON.stringify({
      local: await side.evaluate(() => chrome.storage.local.get(null)),
      session: await side.evaluate(() => chrome.storage.session.get(null))
  });
  const leaked = SECRETS.filter((value) => stored.includes(value));
  check("nothing typed while signing in is in extension storage (saved workflow, recording, chat)", leaked.length === 0, leaked.length ? `found ${leaked.length} value(s)` : "");
  check("the saved recording kept the clicks", /Saved “Workflow/.test(await panelText()));
  const listed = await command("learn-api", "site_skill", {
    action: "learn_api",
    name: "signin",
    skill_name: "Sign-in stand-in",
    from_watch: [signInRecording],
    pick_request: `POST ${shop.origin}/account/login`
  });
  const listedText = JSON.stringify(listed);
  check(
    "the recording's network capture holds no sign-in request",
    !listed.ok && /no captured request/i.test(listed.error?.message || "") && !SECRETS.some((value) => listedText.includes(value)),
    clip(listed.error?.message || listed.data)
  );
  const bridgeFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && fs.statSync(full).size < 20_000_000) bridgeFiles.push(fs.readFileSync(full, "latin1"));
    }
  };
  walk(path.join(home, ".browserharness-bridge"));
  check("nothing typed while signing in is in the Bridge's files", !bridgeFiles.some((text) => SECRETS.some((value) => text.includes(value))));

  });

  await section("signed out", async () => {
    // ------------------------------------------------------------ R5-3: signed out is a sign-in problem
    // signed in now (the sign-in page set the account cookie and token)
    const account = await command("learn-api", "site_skill", {
      action: "learn_api",
      name: "my_orders",
      skill_name: "Account stand-in",
      page_url: `${shop.origin}/my-account`,
      examples: [{}],
      pick_request: `GET ${shop.origin}/api/my-account`
  });
  check("the signed-in account read is learned", account.ok, clip(account.error || account.data?.operation));
  const commands = (await command("agent", "site_commands")).data?.commands || [];
  const orders = commands.find((item) => /my-orders/.test(item.name));
  const signedIn = await command("agent", "site_commands", { name: orders?.name, parameters: {} });
  check("signed in, it returns the person's orders", signedIn.ok && JSON.stringify(signedIn.data).includes("#1001"), clip(signedIn.error || signedIn.data?.run?.output?.api));

  // sign out: the account cookie and the page's token go
  const sid = (await ctx.cookies(shop.origin)).filter((cookie) => cookie.name !== "acct");
  await ctx.clearCookies();
  await ctx.addCookies(sid);
  const page = await ctx.newPage();
  await page.goto(`${shop.origin}/search`);
  await page.evaluate(() => localStorage.removeItem("acctToken"));
  await page.close();
  const signedOut = await command("agent", "site_commands", { name: orders?.name, parameters: {} });
  check(
    "signed out, it fails as a sign-in problem (auth), with no data (RC4: 'unavailable')",
    !signedOut.ok && signedOut.error?.code === "API_AUTH" && signedOut.data?.failure_class === "auth" && !JSON.stringify(signedOut).includes("#1001"),
    clip(signedOut.error)
  );
  const box = panel.getByRole("textbox", { name: "Your request" });
  await box.fill(`/${orders?.name}`);
  await sleep(300);
  await box.press("Escape").catch(() => undefined);
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  const said = await until(async () => /not signed in to/.test(await panelText()), 30000);
  check("the side panel says to sign in", said && !/API_UNAVAILABLE/.test(await panelText()), clip((await panelText()).slice(-300)));
  });
} catch (error) {
  check("Watch Me acceptance ran without crashing", false, error instanceof Error ? error.stack : String(error));
} finally {
  await cdp?.close().catch(() => undefined);
  await harness?.close();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} Watch Me acceptance checks passed (${root})`);
process.exit(failed ? 1 : 0);
