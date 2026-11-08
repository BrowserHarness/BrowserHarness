#!/usr/bin/env node
// Local real-Chromium test of "website → command": BrowserHarness learns a
// stand-in shop (its search form and the JSON request behind its results),
// then the learned recipes run as named commands from a coding agent (typed
// MCP tools), the command line and the side panel (/name). No AI model is used.
// Requires: npm run build, npm run build:bridge, playwright-core. Never runs on GitHub Actions.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
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
const { Client } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/client", { paths: [path.join(root, "apps/bridge")] })).href
);
const { StdioClientTransport } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/client/stdio", { paths: [path.join(root, "apps/bridge")] })).href
);

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), "bh-sites-home-"));
fs.mkdirSync(path.join(home, ".claude"));
const port = 10_800 + Math.floor(Math.random() * 500);
const token = "e2e-" + Math.random().toString(36).slice(2);
fs.mkdirSync(path.join(home, ".browserharness-bridge"));
fs.writeFileSync(
  path.join(home, ".browserharness-bridge", "config.json"),
  JSON.stringify({ host: "127.0.0.1", port, allow_remote: false, token })
);
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local") };
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

// A stand-in shop: a GET search form, and results loaded from its own JSON API.
const PRODUCTS = [
  { name: "Green tea", price: 4.5 },
  { name: "Electric kettle", price: 29 },
  { name: "Steel kettle", price: 19 },
  { name: "Tea cups", price: 12 }
];
const apiCalls = [];
const shop = http.createServer((req, res) => {
  const url = new URL(req.url, "http://shop");
  if (url.pathname === "/api/products/search") {
    apiCalls.push(url.search);
    const q = (url.searchParams.get("q") || "").toLowerCase();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ query: q, results: PRODUCTS.filter((item) => item.name.toLowerCase().includes(q)) }));
    return;
  }
  res.setHeader("content-type", "text/html");
  if (url.pathname === "/search") {
    res.end(`<!doctype html><title>Results</title><h1>Results for ${String(url.searchParams.get("q")).replace(/[<>&]/g, "")}</h1>`);
    return;
  }
  res.end(`<!doctype html><title>Tea Shop</title>
<form action="/search" method="get" name="search">
  <label>Search products <input name="q" aria-label="Search products" required></label>
  <button type="submit">Search</button>
</form>
<ul id="list"></ul>
<script>
  fetch("/api/products/search?q=tea&page=1").then((r) => r.json()).then((data) => {
    document.getElementById("list").innerHTML = data.results.map((item) => "<li>" + item.name + "</li>").join("");
  });
</script>`);
});
await new Promise((resolve) => shop.listen(0, "127.0.0.1", resolve));
const shopUrl = `http://127.0.0.1:${shop.address().port}/`;

const command = async (session, action, args = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}/command`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${currentToken()}` },
    body: JSON.stringify({ session, title: "Sites test", action, args })
  });
  return response.json();
};
const currentToken = () =>
  JSON.parse(fs.readFileSync(path.join(home, ".browserharness-bridge", "config.json"), "utf8")).token;

let ctx;
let mcp;
try {
  const install = await run(bundle, "install", "--json", "--no-service", "--no-pair");
  check("Bridge installs", install.code === 0 && lastJson(install.stdout)?.installed === true, install.stderr.trim());

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bh-sites-"));
  ctx = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME || "/opt/pw-browsers/chromium",
    headless: false,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--headless=new", "--no-sandbox"]
  });
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const extId = sw.url().split("/")[2];
  const side = await ctx.newPage();
  await side.setViewportSize({ width: 430, height: 1200 });
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

  const empty = await command("learn", "site_commands");
  check("with nothing learned, site_commands explains where commands come from", empty.ok && empty.data.commands.length === 0 && /site_skill create/.test(empty.data.hint));

  // 1. BrowserHarness learns the shop: its form and the JSON request behind the list.
  const opened = await command("learn", "open_tab", { url: shopUrl, observe: false });
  await command("learn", "network", { action: "start" });
  await command("learn", "reload", { observe: false });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const created = await command("learn", "site_skill", { action: "create", name: "Tea Shop" });
  const recipes = created.data?.candidate?.recipes || created.data?.recipes || [];
  check(
    "the shop is learned as a Site Skill with a form and a data recipe",
    opened.ok && created.ok && JSON.stringify(created).includes("recipe-api-1") && JSON.stringify(created).includes("recipe-form-1"),
    JSON.stringify(created.error || recipes).slice(0, 300)
  );
  await command("learn", "close_session");

  // 2. Each recipe is now a named command.
  const listed = await command("agent", "site_commands");
  const names = (listed.data?.commands || []).map((item) => item.name);
  const products = listed.data?.commands?.find((item) => item.name === "local-products-search");
  check("site_commands lists named commands", names.includes("local-products-search") && names.includes("local-search"), names.join(", "));
  check(
    "a data command has friendly parameters with the site's defaults",
    products?.kind === "read" && products.parameters.some((p) => p.name === "q") && products.parameters.some((p) => p.name === "page" && p.default === "1"),
    JSON.stringify(products?.parameters)
  );

  // 3. A coding agent sees each command as its own typed tool.
  mcp = new Client({ name: "e2e-sites", version: "1.0.0" });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [installed, "mcp"], env, stderr: "ignore" }));
  let tools = [];
  for (let i = 0; i < 20; i += 1) {
    tools = (await mcp.listTools()).tools;
    if (tools.some((tool) => tool.name === "browserharness_site_local_products_search")) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const tool = tools.find((item) => item.name === "browserharness_site_local_products_search");
  check(
    "MCP lists the command as a typed tool",
    Boolean(tool) && Object.keys(tool.inputSchema?.properties || {}).includes("q") && tool.annotations?.readOnlyHint === true,
    tools.filter((item) => item.name.startsWith("browserharness_site_")).map((item) => item.name).join(", ")
  );
  const before = apiCalls.length;
  const answer = await mcp.callTool({ name: "browserharness_site_local_products_search", arguments: { q: "kettle" } });
  const answered = JSON.parse(answer.content[0].text);
  check(
    "one tool call returns the site's own data",
    answered.ok && answered.data.output.results.length === 2 && answered.data.output.results[0].name === "Electric kettle",
    answer.content[0].text.slice(0, 300)
  );
  check("the command called the site's API with the agent's value", apiCalls.slice(before).some((query) => query.includes("q=kettle")), apiCalls.slice(before).join(" "));
  const wrong = await mcp.callTool({ name: "browserharness_site_commands", arguments: { name: "local-products-search", parameters: { colour: "red" } } });
  check("a wrong parameter is explained", wrong.isError && /has no colour.*q=/.test(wrong.content[0].text), wrong.content[0].text.slice(0, 200));

  // 4. The command line runs them too.
  const sites = await run(installed, "sites");
  check("browserharness-bridge sites lists the commands", sites.code === 0 && /local-products-search.*gets data/.test(sites.stdout), sites.stderr.trim());
  const cliRun = await run(installed, "site", "local-products-search", "--q", "tea");
  let cliJson = null;
  try {
    cliJson = JSON.parse(cliRun.stdout);
  } catch {
    // reported below
  }
  check("browserharness-bridge site <name> prints the data", cliRun.code === 0 && cliJson?.results?.length === 2, (cliRun.stderr || cliRun.stdout).trim().slice(0, 200));
  const form = await run(installed, "site", "local-search", "green tea");
  check("a form command fills and sends the site's form", form.code === 0 && /Filled and sent the form/.test(form.stdout), (form.stderr || form.stdout).trim());
  let resultsTab = null;
  for (let i = 0; i < 20 && !resultsTab; i += 1) {
    resultsTab = ctx.pages().find((item) => item.url().includes("/search?q=green"));
    if (!resultsTab) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  check("the form ran on the real page", Boolean(resultsTab), ctx.pages().map((item) => item.url()).join(" "));
  const tabsBefore = ctx.pages().length;

  // 5. The side panel runs them with /name, no model needed.
  await side.goto(`chrome-extension://${extId}/sidepanel.html`);
  const box = side.getByRole("textbox").last();
  await box.fill("/local-pro");
  await side.getByText("/local-products-search", { exact: true }).first().waitFor({ timeout: 10000 });
  check("typing / suggests website commands", true);
  await box.fill("/local-products-search kettle");
  await box.press("Enter");
  await side.getByText("2 results").first().waitFor({ timeout: 20000 });
  const table = await side.locator("table").last().innerText();
  check("the answer is a table of the site's data", table.includes("Electric kettle") && table.includes("Steel kettle"), table.slice(0, 200));
  check("a data command closes the tab it used", ctx.pages().length <= tabsBefore, `${tabsBefore} → ${ctx.pages().length}`);
  await box.fill("/help");
  await box.press("Enter");
  await side.getByText("Website commands").first().waitFor({ timeout: 10000 });
  check("/help lists website commands", true);
  if (process.env.SHOT_DIR) await side.screenshot({ path: path.join(process.env.SHOT_DIR, "site-command.png"), fullPage: true });

  // 6. Renaming a command on the Skills screen renames the agent tool too.
  await box.fill("/skills");
  await box.press("Enter");
  await side.getByText("Site Skills (built from a website's own requests)").waitFor({ timeout: 10000 });
  check("the Skills screen shows each site's commands", (await side.getByTestId("site-command").count()) >= 2);
  await side.getByRole("button", { name: "Rename command local-products-search" }).click();
  const field = side.getByLabel("Command name");
  await field.fill("find tea");
  await field.press("Enter");
  await side.getByText("/find-tea").waitFor({ timeout: 10000 });
  if (process.env.SHOT_DIR) await side.screenshot({ path: path.join(process.env.SHOT_DIR, "site-commands-skills.png"), fullPage: true });
  await mcp.callTool({ name: "browserharness_site_commands", arguments: {} });
  const renamedTools = (await mcp.listTools()).tools.map((item) => item.name);
  check(
    "a renamed command keeps working under its new name",
    renamedTools.includes("browserharness_site_find_tea") && !renamedTools.includes("browserharness_site_local_products_search"),
    renamedTools.filter((name) => name.startsWith("browserharness_site_")).join(", ")
  );
  const viaNew = await mcp.callTool({ name: "browserharness_site_find_tea", arguments: { q: "cups" } });
  check("the renamed tool runs", JSON.parse(viaNew.content[0].text).data?.output?.results?.[0]?.name === "Tea cups", viaNew.content[0].text.slice(0, 200));
} catch (error) {
  check("sites e2e ran without crashing", false, error instanceof Error ? error.stack : String(error));
} finally {
  await mcp?.close().catch(() => undefined);
  await ctx?.close().catch(() => undefined);
  spawnSync(process.execPath, [bundle, "stop"], { env, timeout: 30_000 });
  spawnSync(process.execPath, [installed, "stop"], { env, timeout: 30_000 });
  shop.close();
  fs.rmSync(home, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} site command checks passed`);
process.exit(passed === results.length ? 0 : 1);
