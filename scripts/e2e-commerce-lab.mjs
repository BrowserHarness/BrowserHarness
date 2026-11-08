#!/usr/bin/env node
// Automated RC5 acceptance against two independent HTTP services, two real
// extension-enabled Chromium profiles and disposable, server-side sessions.
// Local controlled integration evidence; never described as a public-site pass.
import { createRequire } from "node:module";
import { startHarness } from "./lib/api-engine-harness.mjs";
import { startCommerceAcceptanceServer } from "./lib/commerce-acceptance-server.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, details = "") => {
  results.push({ name, status: ok ? "PASS" : "FAIL" });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${details ? ` (${details})` : ""}`);
};
const setup = (name, ok, detail = "") => {
  check(`setup: ${name}`, ok, ok ? "" : String(detail).slice(0, 700));
  if (!ok) throw new Error(`Setup failed: ${name}`);
};
let commerce, first, second, cdp;
try {
  commerce = await startCommerceAcceptanceServer();
  const shopFactory = async () => ({ ...commerce, close: async () => {} });
  first = await startHarness({ check: setup, title: "RC5 commerce acceptance", shopFactory, setupFixtureSession: false });
  const { ctx, side, command, inSidePanel, debugPort } = first;

  const signIn = async (harness, account) => {
    const page = await harness.ctx.newPage();
    await page.goto(`${commerce.origin}/account/login`);
    await page.locator("#email").fill(account.email);
    await page.locator("#password").fill(account.password);
    await page.locator("#signin").click();
    await page.waitForURL(`${commerce.origin}/my-account`, { timeout: 10000 });
    await page.locator("#orders li").first().waitFor({ timeout: 10000 });
    return page;
  };
  const ordersFrom = async (page) => page.locator("#orders").innerText();
  const aPage = await signIn(first, commerce.accounts[0]);
  check("A signs in using a real HTTP form and server-side session", (await ordersFrom(aPage)).includes("LAB-A-1001"));
  const account = await command("commerce-learn-account", "site_skill", {
    action: "learn_api", name: "my_orders", skill_name: "Commerce account",
    page_url: `${commerce.origin}/my-account`, examples: [{}],
    pick_request: `GET ${commerce.origin}/api/my-account`
  });
  check("signed-in account read is learned and verified", account.ok && account.data?.verification?.status === "verified", account.ok ? `tier=${account.data.answered_by_tier}` : `error=${account.error?.code}`);
  const firstRead = account.ok ? await command("commerce-run-account", "site_skill", {
    action: "run", id: account.data.candidate_id, recipe_id: account.data.recipe_id, parameters: {}
  }) : { ok: false };
  check("learned API returns A's server-side orders", firstRead.ok && JSON.stringify(firstRead.data?.run?.output?.data).includes("LAB-A-1001"));
  const storage = JSON.stringify(await side.evaluate(async () => chrome.storage.local.get(null)));
  check("neither sign-in password nor account email is exported to extension storage", commerce.accounts.every((a) => !storage.includes(a.password) && !storage.includes(a.email)));

  // Distinct services and hosts: storefront runs on 127.0.0.1, API on localhost.
  const search = await command("commerce-learn-search", "site_skill", {
    action: "learn_api", name: "product_search", skill_name: "Commerce search",
    page_url: `${commerce.origin}/search?q={q}`,
    examples: [{ q: "laptop" }, { q: "keyboard" }], verify_args: { q: "monitor" }
  });
  check("independent cross-host commerce API search verifies", search.ok && search.data?.verification?.status === "verified" && new URL(search.data.contract.request.url).hostname === "localhost", search.ok ? `tier=${search.data.answered_by_tier}` : `error=${search.error?.code}`);
  if (search.ok) {
    commerce.state.version = 2;
    const failed = await command("commerce-drift", "site_skill", {
      action: "run", id: search.data.candidate_id, recipe_id: search.data.recipe_id, parameters: { q: "tablet" }
    });
    check("HTTP endpoint migration triggers real drift detection", !failed.ok && failed.error?.code === "API_ENDPOINT_DRIFT", failed.ok ? "unexpected success" : `error=${failed.error?.code}`);
    const repaired = await command("commerce-repair", "site_skill", {
      action: "repair", id: search.data.candidate_id, recipe_id: search.data.recipe_id
    });
    check("repair discovers and verifies v2 HTTP endpoint", repaired.ok && repaired.data?.verification === "verified" && repaired.data.changes?.some((x) => x.includes("/api/v2/search")), repaired.ok ? `verified=${repaired.data.verification}` : `error=${repaired.error?.code}`);
    if (repaired.ok) {
      const beforePromotion = await command("commerce-old-active", "site_skill", {
        action: "run", id: search.data.candidate_id, recipe_id: search.data.recipe_id, parameters: { q: "tablet" }
      });
      // An unpromoted candidate can coexist with the old revision; the repair
      // must require explicit promotion before it becomes the chosen contract.
      const promoted = await command("commerce-promote", "site_skill", {
        action: "promote", id: search.data.candidate_id, revision_id: repaired.data.proposed_revision_id
      });
      const updated = await command("commerce-v2-run", "site_skill", {
        action: "run", id: search.data.candidate_id, recipe_id: repaired.data.recipe_id, parameters: { q: "tablet" }
      });
      check("verified repair is promoted explicitly and serves v2 data", !beforePromotion.ok && promoted.ok && updated.ok && JSON.stringify(updated.data?.run?.output?.data).includes("Lab product tablet"), `old=${beforePromotion.error?.code || "unknown"}; promoted=${promoted.ok}`);
    }
  }

  // Exercise the actual side panel consent flow, not a mocked approval helper.
  const product = `${commerce.origin}/products/kit`;
  const demo = await ctx.newPage();
  await demo.goto(product);
  await demo.bringToFront();
  const tabId = await side.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(url))?.id, product);
  const recording = await side.evaluate((id) => chrome.runtime.sendMessage({ type: "WATCH_START", tab_id: id }), tabId);
  await demo.locator("#add").click();
  await demo.getByText("Added", { exact: true }).waitFor({ timeout: 10000 });
  await sleep(1200);
  const stopped = await side.evaluate(() => chrome.runtime.sendMessage({ type: "WATCH_STOP" }));
  await demo.close();
  check("Watch Me records a real cross-origin cart write", recording?.ok && Boolean(stopped?.data?.api_capture?.recording_id) && commerce.state.writes === 1);
  await fetch(`${commerce.apiOrigin}/api/cart/clear`, { method: "POST" });
  const learnedWrite = await command("commerce-learn-write", "site_skill", {
    action: "learn_api", name: "save_cart", skill_name: "Commerce cart",
    from_watch: [stopped?.data?.api_capture?.recording_id], side_effect: "write",
    pick_request: `POST ${commerce.apiOrigin}/api/cart`
  });
  check("cross-host write learns without replaying the demonstration", learnedWrite.ok && learnedWrite.data?.operation?.side_effect === "write" && commerce.state.writes === 1 && new URL(learnedWrite.data?.contract?.request?.url).hostname === "localhost", learnedWrite.ok ? "write learned" : `error=${learnedWrite.error?.code}`);
  if (learnedWrite.ok) {
    await inSidePanel("1");
    cdp = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    let panel;
    for (const p of cdp.contexts().flatMap((context) => context.pages())) {
      if (!p.url().endsWith("/sidepanel.html")) continue;
      if (!(await p.evaluate(() => new Promise((resolve) => chrome.tabs.getCurrent((tab) => resolve(Boolean(tab))))))) panel = p;
    }
    if (!panel) throw new Error("Real Chromium side panel unavailable");
    const ask = panel.getByText("Is it OK to go ahead?");
    const openWrite = async () => {
      const box = panel.getByRole("textbox", { name: "Your request" });
      await box.fill("/local-save-cart");
      await sleep(350);
      await box.press("Escape").catch(() => undefined);
      await panel.getByRole("button", { name: "Send", exact: true }).click();
      await ask.waitFor({ timeout: 20000 });
    };
    await openWrite();
    const approval = await panel.locator(".MuiAlert-root").filter({ hasText: "Is it OK to go ahead?" }).innerText();
    check("write approval names both source website and destination API hosts", /127\.0\.0\.1/.test(approval) && /localhost/.test(approval));
    check("write does not run before consent", commerce.state.writes === 1 && commerce.state.cart.length === 0);
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    await sleep(500);
    check("Cancel sends no cross-host mutation", commerce.state.writes === 1 && commerce.state.cart.length === 0);
    await openWrite();
    // The narrow headless side-panel viewport can cover the button's center
    // with its sticky composer. Trigger the actual React button click handler.
    await panel.getByRole("button", { name: "Approve", exact: true }).evaluate((button) => button.click());
    for (let i = 0; i < 30 && commerce.state.writes < 2; i++) await sleep(250);
    const answerTail = (await panel.locator("body").innerText()).slice(-460).replace(/\s+/g, " ");
    check("Approve sends exactly one write and changes real API cart", commerce.state.writes === 2 && commerce.state.cart.length === 1, `writes=${commerce.state.writes}; cart=${commerce.state.cart.length}; panel=${answerTail}`);
    await fetch(`${commerce.apiOrigin}/api/cart/clear`, { method: "POST" });
    check("disposable cart cleaned after approval", commerce.state.cart.length === 0);
    await cdp.close(); cdp = null;
  }

  // A second complete Chromium user-data directory and Bridge, sharing the
  // same target website, proves customer sessions and Skill data are isolated.
  second = await startHarness({ check: setup, title: "RC5 commerce profile B", shopFactory, setupFixtureSession: false });
  const bPage = await second.ctx.newPage();
  await bPage.goto(`${commerce.origin}/my-account`);
  check("profile B is unauthenticated on A's signed-in store", bPage.url().endsWith("/account/login"));
  const bLibrary = JSON.stringify(await second.side.evaluate(() => chrome.storage.local.get("browserharness.siteSkillLibrary.v2")));
  check("profile B has no profile A learned operations", !bLibrary.includes(account.data?.candidate_id) && !bLibrary.includes(search.data?.candidate_id));
  const bAttempt = account.ok ? await second.command("commerce-profile-isolation", "site_skill", {
    action: "run", id: account.data.candidate_id, recipe_id: account.data.recipe_id, parameters: {}
  }) : { ok: false };
  check("profile B cannot execute profile A's private Skill", !bAttempt.ok);
  await bPage.close();
  const bSignedIn = await signIn(second, commerce.accounts[1]);
  check("B signs into a different account and sees only B's orders", (await ordersFrom(bSignedIn)).includes("LAB-B-2001") && !(await ordersFrom(bSignedIn)).includes("LAB-A-1001"));
  check("A remains signed in as A while B is signed in as B", (await ordersFrom(aPage)).includes("LAB-A-1001"));
  await aPage.locator("#logout").click();
  await aPage.waitForURL(`${commerce.origin}/account/login`, { timeout: 10000 });
  const signedOut = account.ok ? await command("commerce-signed-out", "site_skill", {
    action: "run", id: account.data.candidate_id, recipe_id: account.data.recipe_id, parameters: {}
  }) : { ok: false };
  check("after HTTP sign-out, learned read fails as API_AUTH without old orders", !signedOut.ok && signedOut.error?.code === "API_AUTH" && !JSON.stringify(signedOut).includes("LAB-A-1001"), signedOut.ok ? "unexpected success" : `error=${signedOut.error?.code}`);
  await bSignedIn.reload();
  check("A signing out does not sign out B", (await ordersFrom(bSignedIn)).includes("LAB-B-2001"));
} catch (error) {
  check("commerce acceptance completed without exception", false, error?.message || String(error));
} finally {
  await cdp?.close().catch(() => {});
  await second?.close().catch(() => {});
  await first?.close().catch(() => {});
  await commerce?.close().catch(() => {});
}
const passed = results.filter((item) => item.status === "PASS").length;
console.log(`COMMERCE_LAB ${JSON.stringify({ passed, total: results.length, cases: results })}`);
process.exit(passed === results.length ? 0 : 1);
