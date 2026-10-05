#!/usr/bin/env node
// Local real-Chromium test of the page view reaching shadow DOM (open and closed)
// and same-origin iframes, with one @e ref system shared by observe_page,
// ax_snapshot and every action tool. Stand-in pages, no model, no network.
// Requires: npm run build, playwright-core. Never runs on GitHub Actions.
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

const MAIN = `<!doctype html><title>Deep page</title>
<h1>Deep page</h1>
<button id="light" onclick="log('light')">Light button</button>
<div id="open-host"></div>
<div id="closed-host"></div>
<iframe id="frame" src="/frame" style="width:400px;height:160px"></iframe>
<p id="log"></p>
<div style="margin-top:3000px"><button onclick="log('far')">Far away button</button></div>
<script>
  function log(text) { document.getElementById('log').textContent += '[' + text + ']'; }
  const open = document.getElementById('open-host').attachShadow({ mode: 'open' });
  open.innerHTML = '<label>Shadow name <input aria-label="Shadow name"></label><button>Shadow save</button><button>Delete item</button>';
  open.querySelector('button').onclick = () => log('shadow:' + open.querySelector('input').value);
  const closed = document.getElementById('closed-host').attachShadow({ mode: 'closed' });
  closed.innerHTML = '<button>Closed shadow button</button><span>Secret shadow text</span>';
  closed.querySelector('button').onclick = () => log('closed');
</script>`;
const FRAME = `<!doctype html><title>Frame</title>
<input aria-label="Frame email"><button onclick="parent.log('frame:' + document.querySelector('input').value)">Frame continue</button>
<p>Text inside the frame</p>`;

const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(req.url.startsWith("/frame") ? FRAME : MAIN);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bh-deep-"));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME || "/opt/pw-browsers/chromium",
  headless: false,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--headless=new", "--no-sandbox"]
});

try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const extId = sw.url().split("/")[2];
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForTimeout(500);
  const side = await ctx.newPage();
  await side.goto(`chrome-extension://${extId}/sidepanel.html`);
  const tool = async (name, input = {}) => {
    await page.bringToFront();
    return side.evaluate(
      ([name, input]) =>
        chrome.runtime.sendMessage({ type: "BROWSER_TOOL", tool: name, input, session_id: "deep", session_title: "deep" }),
      [name, input]
    );
  };
  const log = () => page.locator("#log").innerText();

  const obs = await tool("observe_page");
  const elements = obs.data?.elements || [];
  const byName = (name) => elements.find((element) => element.accessible_name === name);
  const names = elements.map((element) => `${element.element_id}:${element.accessible_name}${element.inside ? `(${element.inside})` : ""}`).join(" ");
  check("observe_page reaches the open shadow root", Boolean(byName("Shadow name") && byName("Shadow save")), names);
  check("observe_page reaches the closed shadow root", Boolean(byName("Closed shadow button")), names);
  check("observe_page reaches the same-origin iframe", byName("Frame email")?.inside === "frame" && Boolean(byName("Frame continue")));
  check("text from shadow roots and frames is included", obs.data?.visible_text.includes("Secret shadow text") && obs.data?.visible_text.includes("Text inside the frame"));
  const far = byName("Far away button");
  check("off-screen elements are flagged and listed last", far?.in_viewport === false && elements.at(-1) === far && obs.data?.snapshot.includes("offscreen"));
  const ids = elements.map((element) => element.element_id);
  check("every ref is unique across the page", new Set(ids).size === ids.length);

  // Normal (content-script) actions inside the shadow root and the frame.
  const typed = await tool("type", { element_id: byName("Shadow name").element_id, text: "Ada" });
  const clicked = await tool("click", { element_id: byName("Shadow save").element_id });
  check("type and click work inside a shadow root", typed.ok && clicked.ok && (await log()).includes("[shadow:Ada]"), JSON.stringify(typed.error || clicked.error || ""));
  await tool("type", { element_id: byName("Frame email").element_id, text: "a@b.co" });
  const frameClick = await tool("click", { element_id: byName("Frame continue").element_id });
  check("type and click work inside an iframe", frameClick.ok && (await log()).includes("[frame:a@b.co]"), JSON.stringify(frameClick.error || ""));
  const closedClick = await tool("click", { element_id: byName("Closed shadow button").element_id });
  check("click works inside a closed shadow root", closedClick.ok && (await log()).includes("[closed]"));

  // The same refs work for the trusted (CDP) tools.
  const trusted = await tool("trusted_click", { element_id: byName("Light button").element_id });
  check("trusted_click accepts an observe_page ref", trusted.ok && (await log()).includes("[light]"), JSON.stringify(trusted.error || ""));
  const trustedFrame = await tool("trusted_click", { element_id: byName("Frame continue").element_id });
  check("trusted_click lands inside the iframe", trustedFrame.ok && (await log()).match(/\[frame:a@b\.co\]/g)?.length === 2, JSON.stringify(trustedFrame.error || ""));

  const trustedShadow = await tool("trusted_click", { element_id: byName("Shadow save").element_id });
  check("trusted_click lands inside a shadow root", trustedShadow.ok && (await log()).match(/\[shadow:Ada\]/g)?.length === 2, JSON.stringify(trustedShadow.error || ""));

  // ax_snapshot gives the same element the same ref.
  const ax = await tool("ax_snapshot");
  const axSave = ax.data?.elements?.find((element) => element.name === "Shadow save");
  check("ax_snapshot reuses the page view's ref", axSave?.element_id === byName("Shadow save").element_id, `${axSave?.element_id} vs ${byName("Shadow save").element_id}; ${JSON.stringify(ax.error || "")} ${(ax.data?.elements || []).map((e) => e.element_id + ":" + e.name).join(" ")}`);
  const risky = await tool("trusted_click", { element_id: byName("Delete item").element_id });
  check("trusted_click on an observe_page ref still asks for approval", risky.error?.code === "APPROVAL_REQUIRED" && !(await log()).includes("delete"));
  const again = await tool("observe_page");
  check("refs stay the same across observations", again.data?.elements?.find((element) => element.accessible_name === "Frame email")?.element_id === byName("Frame email").element_id);

  // A ref whose element is gone fails loudly.
  const goneRef = byName("Shadow save").element_id;
  await page.evaluate(() => document.getElementById("open-host").remove());
  const gone = await tool("click", { element_id: goneRef });
  const goneTrusted = await tool("trusted_click", { element_id: goneRef });
  check("a removed element's ref fails instead of clicking something else", !gone.ok && /not found/i.test(gone.error?.message || "") && !goneTrusted.ok, `${gone.error?.message} | ${goneTrusted.error?.message}`);
} catch (error) {
  check("deep page check ran without crashing", false, error instanceof Error ? error.stack : String(error));
} finally {
  await ctx.close().catch(() => undefined);
  server.close();
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} deep page checks passed`);
process.exit(passed === results.length ? 0 : 1);
