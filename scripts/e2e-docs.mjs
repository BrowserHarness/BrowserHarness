#!/usr/bin/env node
// Local real-Chromium test of writing into a Google Docs-style editor with a scripted mock model.
// docs.google.com is served by a local fixture (no network, no Google account). Like the real editor,
// the fixture ignores synthetic (untrusted) events: only real browser input lands in the document.
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

const SCRIPT = "AI is changing how we work.\nIn 30 seconds: what comes next.";

// The fixture: a canvas-like page plus Google's hidden text-event iframe. Trusted text and Enter
// presses inside the iframe are "rendered" into #doc; untrusted events are counted and ignored.
const DOC_HTML = `<!doctype html><html><head><title>Untitled document - Google Docs</title></head>
<body>
<div class="kix-appview-editor"><div id="doc" role="document" aria-label="Document content"></div></div>
<iframe class="docs-texteventtarget-iframe" style="position:absolute;top:-10000px" tabindex="-1"></iframe>
<script>
  const frame = document.querySelector(".docs-texteventtarget-iframe");
  const fdoc = frame.contentDocument;
  fdoc.open(); fdoc.write('<html><body contenteditable="true"></body></html>'); fdoc.close();
  window.__untrusted = 0;
  const docEl = document.getElementById("doc");
  fdoc.addEventListener("beforeinput", (e) => {
    if (!e.isTrusted) { window.__untrusted++; e.preventDefault(); return; }
    e.preventDefault();
    if (e.inputType === "insertText" && e.data) docEl.textContent += e.data;
    if (e.inputType === "insertParagraph" || e.inputType === "insertLineBreak") docEl.textContent += "\\n";
  }, true);
  for (const type of ["keypress", "keydown", "input"]) {
    fdoc.addEventListener(type, (e) => { if (!e.isTrusted) window.__untrusted++; }, true);
  }
</script>
</body></html>`;

const modelCalls = [];
const reply = (res, content) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(content) } }] }));
};

const server = http
  .createServer((req, res) => {
    if (!req.url.startsWith("/v1/chat/completions")) {
      res.statusCode = 404;
      return res.end("{}");
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      const user = String(body.messages.at(-1).content?.[0]?.text ?? body.messages.at(-1).content ?? "");
      const system = String(body.messages[0].content ?? "");
      modelCalls.push({ system, user });
      const clicks = (user.match(/click:/g) || []).length;
      const typed = /\btype:/.test(user);
      // A small model's habit: click into the document first, then write.
      if (user.includes("CLICK_FIRST") && clicks === 0 && !typed) {
        return reply(res, { kind: "tool", tool: "click", input: { element_id: "bc-google-doc-editor" }, note: "Click into the Google Doc body to focus it" });
      }
      if (!typed) {
        return reply(res, { kind: "tool", tool: "type", input: { element_id: "bc-google-doc-editor", text: SCRIPT, replace: false }, note: "Writing the script into the document" });
      }
      return reply(res, { kind: "final", message: "Wrote the script into the document." });
    });
  })
  .listen(0);
const port = server.address().port;

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bh-docs-"));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME || "/opt/pw-browsers/chromium",
  headless: false,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--headless=new", "--no-sandbox"]
});
await ctx.route("https://docs.google.com/**", (route) =>
  route.fulfill({ status: 200, contentType: "text/html", body: DOC_HTML })
);

try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const extId = sw.url().split("/")[2];
  const doc = await ctx.newPage();
  await doc.goto("https://docs.google.com/document/d/test-doc/edit");
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
    capabilities: { chat: true, agent: true, vision: false, embedding: false, unknown: false },
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

  const ask = async (text) => {
    await doc.bringToFront();
    const box = side.locator("textarea").first();
    await box.fill(text);
    await side.getByRole("button", { name: "Send" }).click();
    await side
      .waitForFunction(() => /Wrote the script|loop|failed|error/i.test(document.body.innerText.split("Agent activity").pop() || ""), null, { timeout: 45000 })
      .catch(() => {});
    await side.waitForTimeout(500);
  };
  const docText = () => doc.evaluate(() => document.getElementById("doc").textContent);

  await ask("write a 30 sec video script about AI on this doc");
  const first = modelCalls.find((call) => call.user.includes("30 sec"));
  check("the planner is told how to write into Google Docs", Boolean(first?.system.includes("bc-google-doc-editor")));
  check("the page shows the Google Docs editor as a target", Boolean(first?.user.includes("bc-google-doc-editor")));
  const text1 = await docText();
  check("the script lands in the document as real typing, line breaks included", text1 === SCRIPT, JSON.stringify(text1));
  check("the task finishes with an answer", (await side.locator("body").innerText()).includes("Wrote the script into the document."));

  await doc.evaluate(() => (document.getElementById("doc").textContent = ""));
  await ask("CLICK_FIRST write a 30 sec video script about AI on this doc");
  const sidebar = await side.locator("body").innerText();
  check("clicking into the document first does not loop", !/repeated action loop/i.test(sidebar) && sidebar.includes("Wrote the script into the document."), sidebar.slice(-200).replace(/\n/g, " | "));
  check("text still lands after a click", (await docText()) === SCRIPT, JSON.stringify(await docText()));
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} Google Docs checks passed`);
process.exit(failed ? 1 : 0);
