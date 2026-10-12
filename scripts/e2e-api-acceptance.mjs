#!/usr/bin/env node
// Automated acceptance of the native API engine, end to end, in real Chromium
// with the built extension and the built Bridge: learn → run → approve →
// verify, driven through the person's real side panel (its chat box and its
// approval buttons), against local stand-ins for the sites of the RC3
// real-site acceptance (a Shopify product page that sends Add to cart as
// multipart/form-data, and a signed-in search whose page sends a token from
// its storage a moment after it loads). No AI model, no internet.
// Requires: npm run build, npm run build:bridge, playwright-core. Never runs on GitHub Actions.
import { createRequire } from "node:module";
import { startHarness, STORAGE_TOKEN, root } from "./lib/api-engine-harness.mjs";

const require = createRequire(import.meta.url);
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const clip = (value, size = 400) => String(typeof value === "string" ? value : JSON.stringify(value)).slice(0, size);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let harness;
let cdp;
try {
  harness = await startHarness({ check, title: "API acceptance" });
  const { ctx, side, shop, command, debugPort, inSidePanel } = harness;
  const product = `${shop.origin}/products/akshat`;

  // The person's cart, as the site shows it to their browser
  const browserCart = async () => {
    const page = await ctx.newPage();
    await page.goto(`${shop.origin}/cart.js`);
    const cart = JSON.parse(await page.innerText("body"));
    await page.close();
    return cart;
  };
  const clearCart = async () => {
    const page = await ctx.newPage();
    await page.goto(product);
    await page.evaluate(() => fetch("/cart/clear.js", { method: "POST" }));
    await page.close();
  };

  // ------------------------------------------------------------ learning
  // 1. The product page is learned as a Site Skill: its Add to cart form.
  await command("learn", "open_tab", { url: product, observe: false });
  await command("learn", "network", { action: "start" });
  await command("learn", "reload", { observe: false });
  await sleep(1200);
  const created = await command("learn", "site_skill", { action: "create", name: "Sabpuja stand-in" });
  await command("learn", "close_session");
  const skillId = created.data?.candidate?.id || created.data?.id;
  check("the product page is learned as a Site Skill with its Add to cart form", created.ok && Boolean(skillId) && JSON.stringify(created).includes("recipe-form-"), clip(created.error || created.data));

  // 2. The person shows Add to cart once with Watch Me (the only add they make).
  const tabIdOf = (url) => side.evaluate(async (prefix) => (await chrome.tabs.query({})).find((tab) => tab.url?.startsWith(prefix))?.id, url);
  const demoPage = await ctx.newPage();
  await demoPage.goto(product);
  await demoPage.bringToFront();
  const started = await side.evaluate((id) => chrome.runtime.sendMessage({ type: "WATCH_START", tab_id: id }), await tabIdOf(product));
  await demoPage.locator("#add").click();
  await demoPage.locator("#done").filter({ hasText: "Added" }).waitFor({ timeout: 10000 });
  await demoPage.waitForTimeout(1500);
  const stopped = await side.evaluate(() => chrome.runtime.sendMessage({ type: "WATCH_STOP" }));
  await demoPage.close();
  const capture = stopped?.data?.api_capture;
  check("the demonstration added to the cart once, by the person", started?.ok && shop.state.cartAdds === 1 && (await browserCart()).item_count === 1, clip(started?.error || capture));
  await clearCart();
  check("the cart is emptied before the engine runs", (await browserCart()).item_count === 0);

  // 3. The write is learned from the demonstration without being sent again.
  const learned = await command("learn-api", "site_skill", {
    action: "learn_api",
    id: skillId,
    name: "add_to_cart",
    from_watch: [capture?.recording_id],
    side_effect: "write",
    pick_request: `POST ${shop.origin}/cart/add`
  });
  const contract = learned.data?.contract;
  check(
    "the multipart Add to cart is learned as a write without sending it again",
    learned.ok && learned.data.operation?.side_effect === "write" && shop.state.cartAdds === 1,
    clip(learned.error || learned.data?.operation)
  );
  check(
    "the learned write names its item: Akshat (Rice), variant 44012345678901",
    contract?.target?.kind === "fixed" && contract.target.label === "Akshat (Rice)" && contract.target.fields.some((field) => field.name === "id" && field.value === "44012345678901"),
    clip(contract?.target)
  );
  const cartCookie = (await ctx.cookies(shop.origin)).find((cookie) => cookie.name === "cart")?.value || "none";
  const library = async () => JSON.stringify(await side.evaluate(async () => chrome.storage.local.get(null)));
  check("no cart cookie, session cookie or token is stored in the Skill library", !(await library()).includes(cartCookie) && !(await library()).includes(STORAGE_TOKEN));

  // 4. The plain command name runs the learned request; the form keeps its own name.
  const commands = (await command("agent", "site_commands")).data?.commands || [];
  const addCommand = commands.find((item) => item.name === "local-add-to-cart");
  const formCommand = commands.find((item) => !item.runs_without_page);
  check(
    "/local-add-to-cart is the learned API write; the page's form keeps a name of its own",
    addCommand?.runs_without_page === true && /Akshat \(Rice\)/.test(addCommand?.acts_on || "") && Boolean(formCommand) && formCommand.name !== "local-add-to-cart",
    clip(commands.map((item) => `${item.name}${item.runs_without_page ? " (API)" : ""}`))
  );

  // ------------------------------------------------------------ approval, in the real side panel
  // An "Always allow on this site" grant saved earlier (as in the RC3 run) must not answer a write.
  await side.evaluate(async () => {
    await chrome.storage.local.set({ "browserharness.siteApprovalGrants.v1": [{ host: "127.0.0.1", granted_at: new Date().toISOString() }] });
  });
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
  await panel.reload();
  const question = panel.getByText("Is it OK to go ahead?");
  const runInPanel = async (text) => {
    const box = panel.getByRole("textbox", { name: "Your request" });
    await box.fill(text);
    await sleep(300);
    await box.press("Escape").catch(() => undefined); // close the command list, keep the text
    await panel.getByRole("button", { name: "Send", exact: true }).click();
  };
  const answers = panel.locator("text=/Sent the learned request|I stopped before sending anything|didn't run|Nothing was sent|Filled the form/");
  let seen = 0;
  // the next answer the panel shows
  const lastAnswer = async () => {
    for (let waited = 0; waited < 30000 && (await answers.count()) <= seen; waited += 250) await sleep(250);
    seen = await answers.count();
    return answers.last().innerText();
  };

  await runInPanel("/local-add-to-cart");
  await question.waitFor({ timeout: 20000 }).catch(() => undefined);
  const asked = await question.isVisible();
  const prompt = asked ? await panel.locator(".MuiAlert-root").filter({ hasText: "Is it OK to go ahead?" }).innerText() : "";
  check("a saved site grant does not answer a write: the side panel asks", asked && shop.state.cartAdds === 1, clip(prompt || (await panel.locator("body").innerText()).slice(-400)));
  check("the question names Akshat (Rice)", /Akshat \(Rice\)/.test(prompt) && !/no item of its own/.test(prompt), clip(prompt));
  check("a write's question offers no 'Always allow on this site'", asked && !(await panel.getByRole("button", { name: "Always allow on this site" }).isVisible()));

  // Cancel closes the question and sends nothing
  if (asked) await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  await sleep(800);
  check("Cancel closes the question", !(await question.isVisible()));
  check("after Cancel nothing was sent and the cart is empty", shop.state.cartAdds === 1 && (await browserCart()).item_count === 0, clip(await lastAnswer().catch(() => "no answer")));

  // Approve once: sent once, into the person's own cart, reported as sent and unverified
  await runInPanel("/local-add-to-cart");
  await question.waitFor({ timeout: 20000 });
  await panel.getByRole("button", { name: "Approve", exact: true }).click();
  const approvedAnswer = await lastAnswer().catch(() => "");
  await sleep(500);
  check("Approve closes the question", !(await question.isVisible()));
  check("the approved run sent the learned request exactly once", shop.state.cartAdds === 2, `${shop.state.cartAdds - 1} sent`);
  const cart = await browserCart();
  check(
    "verification: the item is in the person's own cart, not in a cart nobody sees",
    cart.item_count === 1 && cart.items[0]?.product_title === "Akshat" && !shop.state.orphanAdds,
    clip({ cart, orphanAdds: shop.state.orphanAdds || 0 })
  );
  check(
    "the answer says the learned request was sent and is not confirmed (never 'filled the form')",
    /Sent the learned request/.test(approvedAnswer) && /not confirmed/.test(approvedAnswer) && !/Filled the form/.test(approvedAnswer),
    clip(approvedAnswer)
  );

  // Automatic mode does not answer a write either
  await panel.evaluate(async () => {
    const key = "browserharness.preferences";
    const current = (await chrome.storage.local.get(key))[key] || {};
    await chrome.storage.local.set({ [key]: { ...current, approvalMode: "auto" } });
  });
  await sleep(500);
  await runInPanel("/local-add-to-cart");
  await question.waitFor({ timeout: 20000 }).catch(() => undefined);
  const askedInAuto = await question.isVisible();
  if (askedInAuto) await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  await sleep(800);
  check("automatic mode still asks before a write, and Cancel sends nothing", askedInAuto && shop.state.cartAdds === 2 && !(await question.isVisible()));

  // An accepted write is not evidence for promotion
  const promote = await command("agent", "site_skill", { action: "promote", id: skillId });
  check("a Skill whose write is only sent, not verified, is not promoted", !promote.ok, clip(promote.error || promote.data));

  // ------------------------------------------------------------ tier 3 with a session value
  const records = await command("learn-api", "site_skill", {
    action: "learn_api",
    name: "records",
    page_url: `${shop.origin}/token-search?q={q}`,
    examples: [{ q: "laptops" }, { q: "keyboards" }],
    verify_args: { q: "monitors" },
    skill_name: "Records stand-in"
  });
  check(
    "a search whose page sends a storage token and a one-time value is learned and verified live",
    records.ok && records.data?.verification?.status === "verified",
    clip(records.error || records.data?.verification)
  );
  const recordsRun = await command("agent", "site_skill", { action: "run", id: records.data?.candidate_id, recipe_id: records.data?.recipe_id, parameters: { q: "tablets" } });
  const ranOutput = recordsRun.data?.run?.output;
  check(
    "it runs through the page (tier 3) with the new input, not a false endpoint_drift",
    recordsRun.ok && ranOutput?.api?.tier === 3 && JSON.stringify(ranOutput?.data).includes("Slate tablet"),
    clip(recordsRun.error || ranOutput)
  );
  check("the storage token is not stored in the Skill library", !(await library()).includes(STORAGE_TOKEN));
} catch (error) {
  check("API acceptance ran without crashing", false, error instanceof Error ? error.stack : String(error));
} finally {
  await cdp?.close().catch(() => undefined);
  await harness?.close();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} API acceptance checks passed (${root})`);
process.exit(failed ? 1 : 0);
