#!/usr/bin/env node
// Manual third-party RC5 acceptance on a public demo storefront.
// Use only a unique disposable guest cart. Never check out or run in CI.
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { startHarness } from "./lib/api-engine-harness.mjs";

const website = "https://www.demoblaze.com";
const apiHost = "api.demoblaze.com";
const productName = "Samsung galaxy s6";
const results = [];
const check = (name, passed, detail = "") => {
  results.push({ name, status: passed ? "PASS" : "FAIL" });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};
const setup = (name, passed, detail = "") => {
  check(`setup: ${name}`, passed, passed ? "" : String(detail).slice(0, 160));
  if (!passed) throw new Error(`Setup failed: ${name}`);
};

let harness;
let cartPage;
let cdp;
const isCartCall = (response) =>
  new URL(response.url()).hostname === apiHost &&
  new URL(response.url()).pathname === "/viewcart";
const cartCount = async () => {
  const response = cartPage.waitForResponse(isCartCall, { timeout: 20000 });
  await cartPage.goto(`${website}/cart.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
  const result = await response;
  if (!result.ok()) throw new Error(`Cart read failed with HTTP ${result.status()}`);
  const body = await result.json();
  if (!Array.isArray(body?.Items)) throw new Error("Cart API returned an unexpected response");
  const expectedCount = body.Items.length;
  // The page fetches each product separately after viewcart returns.
  // Wait for those independent HTTP reads before inspecting its rendered rows.
  await cartPage.waitForFunction(
    (count) => document.querySelectorAll("#tbodyid tr").length === count,
    expectedCount, { timeout: 15000 }
  );
  return expectedCount;
};
const removeTestItem = async () => {
  const count = await cartCount();
  if (count === 0) return true;
  const rows = cartPage.locator("#tbodyid tr");
  const ownRows = rows.filter({ hasText: productName });
  if (count !== 1 || (await ownRows.count()) !== 1) {
    throw new Error("Guest cart has unexpected items; test will not delete them");
  }
  const deleted = cartPage.waitForResponse((response) =>
    new URL(response.url()).hostname === apiHost &&
    new URL(response.url()).pathname === "/deleteitem", { timeout: 20000 });
  await ownRows.getByText("Delete", { exact: true }).click();
  const response = await deleted;
  if (!response.ok()) throw new Error(`Guest item deletion failed with HTTP ${response.status()}`);
  return (await cartCount()) === 0;
};

try {
  harness = await startHarness({ title: "RC5 public demo cross-host write", check: setup, setupFixtureSession: false });
  const { ctx, side, command } = harness;
  await ctx.addCookies([{ name: "rc5_guest", value: randomUUID(), domain: "www.demoblaze.com", path: "/" }]);
  cartPage = await ctx.newPage();
  const empty = (await cartCount()) === 0;
  check("unique disposable guest cart starts empty", empty);
  if (!empty) throw new Error("Guest cart was not empty; declining to change its contents");

  const productPage = await ctx.newPage();
  productPage.on("dialog", (dialog) => dialog.accept());
  await productPage.goto(`${website}/prod.html?idp_=1`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await productPage.getByRole("link", { name: "Add to cart" }).waitFor({ timeout: 15000 });
  await productPage.bringToFront();
  const tabId = await side.evaluate(async (url) =>
    (await chrome.tabs.query({})).find((tab) => tab.url?.startsWith(url))?.id,
    `${website}/prod.html?idp_=1`);
  const recording = await side.evaluate((id) => chrome.runtime.sendMessage({ type: "WATCH_START", tab_id: id }), tabId);
  const writeResponse = productPage.waitForResponse((response) =>
    new URL(response.url()).hostname === apiHost &&
    new URL(response.url()).pathname === "/addtocart" && response.request().method() === "POST",
    { timeout: 20000 });
  await productPage.getByRole("link", { name: "Add to cart" }).click();
  const added = await writeResponse;
  await productPage.waitForTimeout(1200);
  const stopped = await side.evaluate(() => chrome.runtime.sendMessage({ type: "WATCH_STOP" }));
  const capture = stopped?.data?.api_capture;
  const demoCartCount = await cartCount();
  check("Watch Me captures real demo API write on different host",
    recording?.ok && added.ok() && Boolean(capture?.recording_id) && demoCartCount === 1,
    `status=${added.status()}, recording_ok=${Boolean(recording?.ok)}, recorded=${Boolean(capture?.recording_id)}, cart=${demoCartCount}`);
  check("demonstration cart item removed", await removeTestItem());

  const learned = await command("demoblaze-learn", "site_skill", {
    action: "learn_api", name: "add-to-demo-cart", skill_name: "RC5 DemoBlaze guest cart",
    from_watch: [capture?.recording_id], side_effect: "write",
    pick_request: `POST https://${apiHost}/addtocart`
  });
  check("external write learned without replaying it",
    learned.ok && learned.data?.operation?.side_effect === "write" &&
    new URL(learned.data?.contract?.request?.url).hostname === apiHost && (await cartCount()) === 0,
    learned.ok ? "write operation captured" : `error=${learned.error?.code ?? "unknown"}`);
  if (!learned.ok) throw new Error("External cross-host write could not be learned");

  const direct = await command("demoblaze-run", "site_skill", {
    action: "run", id: learned.data.candidate_id, recipe_id: learned.data.recipe_id
  });
  check("direct write requires approval and leaves cart empty",
    !direct.ok && /APPROVAL/.test(direct.error?.code ?? "") && (await cartCount()) === 0);
  const commands = (await command("demoblaze-commands", "site_commands")).data?.commands ?? [];
  const writeCommand = commands.find((candidate) =>
    candidate.kind === "form" && candidate.runs_without_page && /add-to-demo-cart/.test(candidate.name));
  if (!writeCommand) throw new Error("No named approval-gated guest-cart command was registered");

  await harness.inSidePanel("1");
  cdp = await chromium.connectOverCDP(`http://127.0.0.1:${harness.debugPort}`);
  let panel;
  for (const page of cdp.contexts().flatMap((context) => context.pages())) {
    if (!page.url().endsWith("/sidepanel.html")) continue;
    const isTab = await page.evaluate(() => new Promise((resolve) => chrome.tabs.getCurrent((tab) => resolve(Boolean(tab)))));
    if (!isTab) panel = page;
  }
  if (!panel) throw new Error("Real side panel could not be opened");
  const prompt = panel.getByText("Is it OK to go ahead?");
  const openApproval = async () => {
    const box = panel.getByRole("textbox", { name: "Your request" });
    await box.fill(`/${writeCommand.name}`);
    await box.press("Escape").catch(() => undefined);
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await prompt.waitFor({ timeout: 20000 });
  };
  await openApproval();
  const consentText = await panel.locator(".MuiAlert-root").filter({ hasText: "Is it OK to go ahead?" }).innerText();
  check("live approval names source and API destinations",
    consentText.includes("www.demoblaze.com") && consentText.includes(apiHost));
  check("guest cart unchanged before approval", (await cartCount()) === 0);
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  check("Cancel prevents the external write", (await cartCount()) === 0);
  await openApproval();
  await panel.getByRole("button", { name: "Approve", exact: true }).evaluate((button) => button.click());
  await panel.getByText(/Sent the learned request/).last().waitFor({ timeout: 25000 });
  check("one approved live API cart item appears", (await cartCount()) === 1);
  check("approved item removed from guest cart", await removeTestItem());
} catch (error) {
  check("public cross-host acceptance finished without exception", false, String(error?.message ?? error).slice(0, 300));
} finally {
  if (cartPage) {
    try {
      check("guest cart empty after final cleanup", await removeTestItem());
    } catch (error) {
      check("guest cart empty after final cleanup", false, String(error?.message ?? error).slice(0, 200));
    }
  }
  await cdp?.close().catch(() => undefined);
  await harness?.close().catch(() => undefined);
}
const passed = results.filter((result) => result.status === "PASS").length;
console.log(`DEMOBLAZE_CROSSHOST ${JSON.stringify({ passed, total: results.length, cases: results })}`);
process.exit(passed === results.length ? 0 : 1);
