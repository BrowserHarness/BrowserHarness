#!/usr/bin/env node
// Local real-Chromium smoke test for the built extension (never runs on GitHub Actions).
// Requires: npm run build, and playwright-core resolvable (e.g. `npm i --no-save playwright-core`).
// Env: CHROME=/path/to/chromium (default /opt/pw-browsers/chromium).
// Drives the real service worker through BROWSER_TOOL messages: observe, network capture,
// Site Skill create (form + API recipes), and an executable API recipe run. No model involved.
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

const server = http
  .createServer((req, res) => {
    if (req.url.startsWith("/api/items")) {
      const q = new URL(req.url, "http://x").searchParams.get("q");
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ query: q, items: ["a", "b"] }));
    }
    res.setHeader("content-type", "text/html");
    res.end(`<html><head><title>Smoke Shop</title></head><body><h1>Shop</h1>
<form action="/s" method="get"><label>Email <input name="email" type="text"></label><button type="submit">Go</button></form>
<script>fetch("/api/items?q=shoes&page=1").then(r=>r.json()).then(d=>document.title="Smoke Shop "+d.items.length)</script></body></html>`);
  })
  .listen(0);
const port = server.address().port;

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bh-smoke-"));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME || "/opt/pw-browsers/chromium",
  headless: false,
  args: [
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    "--headless=new",
    "--no-sandbox"
  ]
});

try {
  const sw =
    ctx.serviceWorkers()[0] ||
    (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  check("service worker starts", sw.url().endsWith("service-worker.js"));
  const extId = sw.url().split("/")[2];

  const page = await ctx.newPage();
  await page.goto(`http://localhost:${port}/`);
  const side = await ctx.newPage();
  await side.goto(`chrome-extension://${extId}/sidepanel.html`);
  await side.waitForTimeout(1000);
  check("side panel renders", (await side.locator("body").innerText()).includes("Give your browser a task"));

  const tool = async (name, input = {}) => {
    await page.bringToFront();
    return side.evaluate(
      ([name, input]) =>
        chrome.runtime.sendMessage({
          type: "BROWSER_TOOL",
          tool: name,
          input,
          session_id: "smoke",
          session_title: "smoke"
        }),
      [name, input]
    );
  };

  const obs = await tool("observe_page");
  check("observe_page sees the form", obs.ok && obs.data.snapshot.includes('textbox "email"'));

  const ax = await tool("ax_snapshot");
  const emailRef = ax.ok
    ? ax.data.elements.find((e) => e.role === "textbox")?.element_id
    : undefined;
  const typed = await tool("trusted_type", { element_id: emailRef, text: "me@example.com" });
  check("trusted_type enters text", typed.ok, JSON.stringify(typed.ok ? typed.data : typed.error));
  const keyed = await tool("send_keys", { keys: "Enter" });
  await page.waitForTimeout(800);
  check(
    "send_keys Enter submits the form",
    keyed.ok && page.url().includes("/s?email=me%40example.com"),
    page.url()
  );
  const read = await tool("read_page");
  check("read_page returns page text", read.ok);
  await page.goto(`http://localhost:${port}/`);
  await page.waitForTimeout(500);

  const net = await tool("network", { action: "start" });
  check("network capture starts", net.ok);
  await page.reload();
  await page.waitForTimeout(800);

  const created = await tool("site_skill", { action: "create", name: "Smoke Shop" });
  const recipes = created.ok ? created.data.candidate.recipes.map((r) => r.id) : [];
  check("site_skill create learns form + API recipes", recipes.includes("recipe-form-1") && recipes.includes("recipe-api-1"), recipes.join(","));

  if (created.ok) {
    const candidate = created.data.candidate;
    const api = candidate.recipes.find((r) => r.id.startsWith("recipe-api"));
    const run = await tool("site_skill", {
      action: "run",
      id: candidate.id,
      recipe_id: api.id,
      parameters: { [api.parameters[0]]: "boots" }
    });
    check(
      "API recipe runs in-page and returns site JSON",
      run.ok && run.data.run.output?.data?.query === "boots",
      JSON.stringify(run.ok ? run.data.run.output?.data : run.error)
    );
    const hist = await tool("site_skill", { action: "history", id: candidate.id });
    check("execution evidence recorded", hist.ok && JSON.stringify(hist.data).includes("recipe-api-1"));
  }
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} smoke checks passed`);
process.exit(failed ? 1 : 0);
