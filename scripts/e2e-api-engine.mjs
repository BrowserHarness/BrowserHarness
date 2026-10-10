#!/usr/bin/env node
// Local real-Chromium test of the native API engine: the built extension runs
// a local stand-in shop twice in background tabs (two example searches), the
// Bridge learns the request behind the results, checks it live with a third
// search, and the saved recipe then runs without opening the site. Covers a
// plain GET API and a persisted GraphQL query. No AI model, no internet.
// Requires: npm run build, npm run build:bridge, playwright-core. Never runs on GitHub Actions.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "apps/extension/dist");
const bundle = path.join(root, "apps/bridge/dist/browserharness-bridge.mjs");
for (const file of [path.join(dist, "manifest.json"), bundle]) {
  if (!fs.existsSync(file)) {
    console.error("Build first: npm run build && npm run build:bridge");
    process.exit(2);
  }
}
const { startApiShop } = await import(path.join(root, "apps/bridge/test/fixtures/api-shop.mjs"));

const results = [];
const timings = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), "bh-api-home-"));
const port = 11_300 + Math.floor(Math.random() * 500);
const token = "e2e-" + Math.random().toString(36).slice(2);
fs.mkdirSync(path.join(home, ".browserharness-bridge"));
fs.writeFileSync(path.join(home, ".browserharness-bridge", "config.json"), JSON.stringify({ host: "127.0.0.1", port, allow_remote: false, token }));
const env = { ...process.env, HOME: home, USERPROFILE: home };
const installed = path.join(home, ".browserharness-bridge", "bin", "browserharness-bridge.mjs");
const run = (file, ...args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
const lastJson = (text) => {
  try {
    return JSON.parse(text.trim().split("\n").at(-1) || "");
  } catch {
    return null;
  }
};
const currentToken = () => JSON.parse(fs.readFileSync(path.join(home, ".browserharness-bridge", "config.json"), "utf8")).token;
const command = async (session, action, args = {}) => {
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}/command`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${currentToken()}` },
    body: JSON.stringify({ session, title: "API engine test", action, args })
  });
  const body = await response.json();
  body.elapsed_ms = Math.round(performance.now() - started);
  return body;
};

const shop = await startApiShop();
const SESSION_COOKIE = "valid-session-123456";
const STORAGE_TOKEN = "tok_9fK2mQ7vX1pL8sD4hJ6w";
let ctx;
try {
  const install = await run(bundle, "install", "--json", "--no-service", "--no-pair");
  check("Bridge installs", install.code === 0 && lastJson(install.stdout)?.installed === true, install.stderr.trim());

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bh-api-"));
  ctx = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME || "/opt/pw-browsers/chromium",
    headless: false,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--headless=new", "--no-sandbox"]
  });
  // a signed-in-looking session on the shop, to prove its values are not kept
  await ctx.addCookies([{ name: "sid", value: SESSION_COOKIE, url: shop.origin }]);
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const extId = sw.url().split("/")[2];
  const side = await ctx.newPage();
  await side.goto(`chrome-extension://${extId}/sidepanel.html`);
  await side.evaluate(async (address) => {
    await chrome.storage.local.set({ "browserharness.bridgeSettings": { enabled: false, address, token: "" } });
  }, `ws://127.0.0.1:${port}/ws`);
  await side.reload();
  await side.getByRole("button", { name: "Settings" }).first().click();
  await side.getByRole("button", { name: /^Helper app/ }).click();
  await side.getByText("Set it up", { exact: true }).waitFor({ timeout: 10000 });
  await side.getByRole("button", { name: "Pair", exact: true }).click();
  const code = (await side.getByLabel("Pairing code").innerText({ timeout: 10000 })).replace(/\D/g, "");
  const paired = await run(installed, "pair", "--code", code, "--json");
  check("extension pairs with the Bridge", lastJson(paired.stdout)?.paired === true, paired.stderr.trim());
  const shopPage = await ctx.newPage();
  await shopPage.goto(`${shop.origin}/search`);
  await shopPage.evaluate((value) => localStorage.setItem("authToken", value), STORAGE_TOKEN);
  await shopPage.close();

  const tabsBefore = ctx.pages().length;
  const learned = await command("learn-api", "site_skill", {
    action: "learn_api",
    name: "search",
    page_url: `${shop.origin}/search?q={q}`,
    examples: [{ q: "laptops" }, { q: "keyboards" }],
    verify_args: { q: "monitors" },
    skill_name: "Fixture shop"
  });
  timings.push(["learn_api (2 page runs + learn + live check)", learned.elapsed_ms]);
  check(
    "learn_api learns the GET search from two runs and verifies it with a third input",
    learned.ok && learned.data.verification.status === "verified" && learned.data.operation.side_effect === "read",
    JSON.stringify(learned.error || learned.data?.verification).slice(0, 400)
  );
  check("the third input's live answer is that input's data", JSON.stringify(learned.data?.result_preview || "").includes("27 inch monitor"));
  check("the background tabs it used are closed", ctx.pages().length === tabsBefore, `${tabsBefore} → ${ctx.pages().length}`);
  const sentQueries = shop.state.requests.filter((item) => item.path === "/api/search").map((item) => new URLSearchParams(item.search).get("q"));
  check("both example runs and the live check reached the shop's API", ["laptops", "keyboards", "monitors"].every((q) => sentQueries.includes(q)), sentQueries.join(","));

  const graph = await command("learn-api", "site_skill", {
    action: "learn_api",
    id: learned.data?.candidate_id,
    name: "searchProducts",
    page_url: `${shop.origin}/gql-search?q={q}`,
    examples: [{ q: "laptops" }, { q: "keyboards" }],
    verify_args: { q: "tablets" }
  });
  check(
    "a persisted GraphQL query is learned into the same Skill",
    graph.ok && graph.data.verification.status === "verified" && graph.data.candidate_id === learned.data?.candidate_id,
    JSON.stringify(graph.error || graph.data?.verification).slice(0, 400)
  );

  const library = await side.evaluate(async () => (await chrome.storage.local.get("browserharness.siteSkillLibrary.v2"))["browserharness.siteSkillLibrary.v2"]);
  const stored = JSON.stringify(library);
  check("no cookie or storage value is stored in the Skill library", !stored.includes(SESSION_COOKIE) && !stored.includes(STORAGE_TOKEN));
  const family = library?.families?.find((item) => item.id === learned.data?.candidate_id);
  check("the Skill stays a candidate: nothing was promoted", family && !family.active_revision_id && family.revisions.length === 2, JSON.stringify(family?.active_revision_id));

  const before = shop.state.requests.length;
  const runStarted = performance.now();
  const ran = await command("agent", "site_skill", { action: "run", id: learned.data?.candidate_id, recipe_id: learned.data?.recipe_id, parameters: { q: "tablets" } });
  timings.push(["site_skill run of the learned GET (tier 1)", Math.round(performance.now() - runStarted)]);
  check(
    "the learned recipe runs without a tab and returns fresh data",
    ran.ok && ran.data.run.output.api.tier === 1 && JSON.stringify(ran.data.run.output.data).includes("Slate tablet"),
    JSON.stringify(ran.error || ran.data?.run?.output).slice(0, 300)
  );
  check("it sent one request with the new input", shop.state.requests.slice(before).length === 1 && shop.state.requests.at(-1).search.includes("q=tablets"));

  const listed = await command("agent", "site_commands");
  const names = (listed.data?.commands || []).map((item) => item.name);
  const cmd = listed.data?.commands?.find((item) => item.name === "local-search");
  check("each learned operation is a named read command", cmd?.kind === "read" && names.includes("local-search-products"), names.join(", "));
  const pagesBefore = ctx.pages().length;
  const viaCommand = await command("agent", "site_commands", { name: "local-search-products", parameters: { q: "monitors" } });
  check(
    "the GraphQL command runs and opens no tab",
    viaCommand.ok && ctx.pages().length === pagesBefore && JSON.stringify(viaCommand.data).includes("34 inch ultrawide monitor"),
    JSON.stringify(viaCommand.error || viaCommand.data || "").slice(0, 300)
  );

  // Hybrid execution: a signed-in API (plain HTTP has no session, the page does)
  const orders = await command("learn-api", "site_skill", {
    action: "learn_api",
    id: learned.data?.candidate_id,
    name: "orders",
    page_url: `${shop.origin}/orders?q={q}`,
    examples: [{ q: "laptops" }, { q: "keyboards" }],
    verify_args: { q: "monitors" }
  });
  check(
    "a signed-in read verifies through the page (tier 2) after plain HTTP answers auth",
    orders.ok && orders.data.verification.status === "verified" && orders.data.answered_by_tier === 2,
    JSON.stringify(orders.error || orders.data?.verification).slice(0, 400)
  );
  const orderRunStarted = performance.now();
  const orderRun = await command("agent", "site_skill", { action: "run", id: learned.data?.candidate_id, recipe_id: orders.data?.recipe_id, parameters: { q: "tablets" } });
  timings.push(["site_skill run of the signed-in read (remembered tier 2)", Math.round(performance.now() - orderRunStarted)]);
  check(
    "the next run goes straight to the remembered page tier",
    orderRun.ok && orderRun.data.run.output.api.tier === 2 && JSON.stringify(orderRun.data.run.output.data).includes("Slate tablet"),
    JSON.stringify(orderRun.error || orderRun.data?.run?.output).slice(0, 300)
  );
  check("the session cookie is still not stored anywhere in the library", !JSON.stringify(await side.evaluate(async () => chrome.storage.local.get(null))).includes(SESSION_COOKIE));

  // A per-load signature: only the page itself can make the request (tier 3)
  const guarded = await command("learn-api", "site_skill", {
    action: "learn_api",
    id: learned.data?.candidate_id,
    name: "guarded",
    page_url: `${shop.origin}/guarded?q={q}`,
    examples: [{ q: "laptops" }, { q: "keyboards" }],
    verify_args: { q: "monitors" }
  });
  check(
    "a request with a per-load signature is learned as page-only and verifies through the page (tier 3)",
    guarded.ok && guarded.data.operation.min_tier === 3 && guarded.data.verification.status === "verified" && guarded.data.answered_by_tier === 3,
    JSON.stringify(guarded.error || guarded.data?.verification).slice(0, 400)
  );
  const guardedStarted = performance.now();
  const guardedRun = await command("agent", "site_skill", { action: "run", id: learned.data?.candidate_id, recipe_id: guarded.data?.recipe_id, parameters: { q: "tablets" } });
  timings.push(["site_skill run of the page-only read (tier 3)", Math.round(performance.now() - guardedStarted)]);
  check(
    "it runs through the page and returns fresh data",
    guardedRun.ok && guardedRun.data.run.output.api.tier === 3 && JSON.stringify(guardedRun.data.run.output.data).includes("Slate tablet"),
    JSON.stringify(guardedRun.error || guardedRun.data?.run?.output).slice(0, 300)
  );

  // Health, drift and repair: the active revision never changes on its own
  const skillId = learned.data?.candidate_id;
  const promoted = await command("agent", "site_skill", { action: "promote", id: skillId });
  check("the verified Skill can be promoted on request", promoted.ok, JSON.stringify(promoted.error || "").slice(0, 300));
  const activeBefore = (await side.evaluate(async () => (await chrome.storage.local.get("browserharness.siteSkillLibrary.v2"))["browserharness.siteSkillLibrary.v2"])).families.find((item) => item.id === skillId).active_revision_id;
  const health = await command("agent", "site_skill", { action: "verify", id: skillId });
  check(
    "site_skill verify calls each learned read live with a taught input",
    health.ok && health.data.health.length === 4 && health.data.health.every((item) => item.passed),
    JSON.stringify(health.data?.health || health.error).slice(0, 400)
  );

  shop.state.searchPath = "/api/v2/search";
  const drifted = await command("agent", "site_skill", { action: "run", id: skillId, recipe_id: learned.data?.recipe_id, parameters: { q: "tablets" } });
  check(
    "when the site moves its API, the run fails as endpoint drift and suggests repair",
    !drifted.ok && drifted.error?.code === "API_ENDPOINT_DRIFT" && drifted.data?.repair_recommended === true && /site_skill repair/.test(drifted.data?.next_action),
    JSON.stringify(drifted).slice(0, 300)
  );
  const repairStarted = performance.now();
  const repaired = await command("agent", "site_skill", { action: "repair", id: skillId, recipe_id: learned.data?.recipe_id });
  timings.push(["site_skill repair (2 page runs + learn + live check)", Math.round(performance.now() - repairStarted)]);
  check(
    "repair learns it again from its page as a verified candidate revision",
    repaired.ok && repaired.data.verification === "verified" && repaired.data.changes.some((item) => item.includes("/api/v2/search")),
    JSON.stringify(repaired.error || repaired.data).slice(0, 400)
  );
  const libraryAfter = await side.evaluate(async () => (await chrome.storage.local.get("browserharness.siteSkillLibrary.v2"))["browserharness.siteSkillLibrary.v2"]);
  const familyAfter = libraryAfter.families.find((item) => item.id === skillId);
  check("the active revision is unchanged by the repair", familyAfter.active_revision_id === activeBefore && familyAfter.latest_revision_id === repaired.data?.proposed_revision_id);
  const stillActive = await command("agent", "site_skill", { action: "run", id: skillId, recipe_id: learned.data?.recipe_id, parameters: { q: "tablets" } });
  check("until promoted, runs still use the active revision", !stillActive.ok && stillActive.error.code === "API_ENDPOINT_DRIFT");
  const promotedRepair = await command("agent", "site_skill", { action: "promote", id: skillId, revision_id: repaired.data?.proposed_revision_id });
  const afterRepair = await command("agent", "site_skill", { action: "run", id: skillId, recipe_id: repaired.data?.recipe_id, parameters: { q: "tablets" } });
  check(
    "after promotion the repaired operation answers from the new endpoint",
    promotedRepair.ok && afterRepair.ok && JSON.stringify(afterRepair.data.run.output.data).includes("Slate tablet"),
    JSON.stringify(promotedRepair.error || afterRepair.error || "").slice(0, 300)
  );
  const again = await command("agent", "site_skill", { action: "repair", id: skillId, recipe_id: repaired.data?.recipe_id });
  check("repairs are bounded: an immediate second repair waits", !again.ok && again.error.code === "API_REPAIR_COOLDOWN", JSON.stringify(again.error));
  shop.state.field = "products";
  const schema = await command("agent", "site_skill", { action: "run", id: skillId, recipe_id: repaired.data?.recipe_id, parameters: { q: "tablets" } });
  check("a renamed response field is schema drift", !schema.ok && schema.error.code === "API_SCHEMA_DRIFT", JSON.stringify(schema.error));
  shop.state.field = "items";

  const write = await command("learn-api", "site_skill", {
    action: "learn_api",
    name: "addToCart",
    page_url: `${shop.origin}/search?q={q}`,
    examples: [{ q: "laptops" }, { q: "keyboards" }],
    verify_args: { q: "monitors" },
    side_effect: "write"
  });
  check("learn_api refuses to learn a write by running it", !write.ok && write.error.code === "API_LEARN_WRITE_REFUSED" && shop.state.writes === 0);
} catch (error) {
  check("API engine e2e ran without crashing", false, error instanceof Error ? error.stack : String(error));
} finally {
  await ctx?.close().catch(() => undefined);
  spawnSync(process.execPath, [bundle, "stop"], { env, timeout: 30_000 });
  spawnSync(process.execPath, [installed, "stop"], { env, timeout: 30_000 });
  await shop.close();
  fs.rmSync(home, { recursive: true, force: true });
}

for (const [label, ms] of timings) console.log(`TIME ${label}: ${ms} ms`);
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} API engine checks passed`);
process.exit(passed === results.length ? 0 : 1);
