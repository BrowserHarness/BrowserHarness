#!/usr/bin/env node
// Local real-Chromium test of the Connect AI screen: local model (LM Studio style server, no key) and the
// subscription option's readiness message. Fake local server, no real model, no network.
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

const seenAuth = [];
const handler = (req, res) => {
    seenAuth.push(req.headers.authorization || "");
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/v1/models")) {
      return res.end(JSON.stringify({ data: [{ id: "qwen2.5-7b-instruct" }, { id: "text-embedding-nomic" }] }));
    }
    if (req.url.startsWith("/v1/chat/completions")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw);
        const user = String(body.messages.at(-1).content?.[0]?.text ?? body.messages.at(-1).content ?? "");
        const content = user.includes("USER GOAL")
          ? JSON.stringify({ kind: "tool", tool: "click", input: { element_id: "bc-health-1" }, note: "Clicking Continue" })
          : "OK";
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
      });
      return;
    }
    res.statusCode = 404;
    res.end("{}");
};
const server = http.createServer(handler).listen(0);
const port = server.address().port;
// The simple screen looks for LM Studio on its usual port.
const lmStudio = http.createServer(handler);
const lmStudioUp = await new Promise((resolve) => {
  lmStudio.once("error", () => resolve(false));
  lmStudio.listen(1234, "127.0.0.1", () => resolve(true));
});

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bh-connect-"));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME || "/opt/pw-browsers/chromium",
  headless: false,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--headless=new", "--no-sandbox"]
});

try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const extId = sw.url().split("/")[2];
  const side = await ctx.newPage();
  await side.setViewportSize({ width: 430, height: 1200 });
  await side.goto(`chrome-extension://${extId}/sidepanel.html`);
  await side.getByRole("button", { name: "Settings" }).first().click();
  await side.getByText("Connect your AI").waitFor({ timeout: 10000 });

  const body0 = await side.locator("body").innerText();
  check("simple screen offers OpenRouter and shows ChatGPT as coming soon", body0.includes("Connect with OpenRouter") && body0.includes("Coming soon"));

  if (lmStudioUp) {
    const lmButton = side.getByRole("button", { name: /Connect LM Studio/ });
    await lmButton.waitFor({ timeout: 15000 }).catch(() => {});
    check("a running local LM Studio is detected automatically", await lmButton.isVisible().catch(() => false));
    await lmButton.click().catch(() => {});
    await side.getByText(/^Saved\./).first().waitFor({ timeout: 30000 }).catch(() => {});
    check("one click connects and tests the local model", /Saved\. Chat ✓/.test(await side.locator("body").innerText()));
  } else {
    console.log("SKIP local auto-detect (port 1234 busy)");
  }

  await side.getByRole("button", { name: /Advanced/ }).click();
  await side.getByText("Add connection").waitFor({ timeout: 10000 });

  const providerBox = side.getByRole("combobox", { name: "Provider" });
  await providerBox.click();
  const options = (await side.getByRole("option").allInnerTexts()).map((t) => t.trim());
  check(
    "provider list offers subscriptions and local models",
    ["Claude subscription", "ChatGPT subscription", "LM Studio (local)", "Ollama (local)"].every((o) => options.includes(o)),
    options.join(" | ")
  );

  await side.getByRole("option", { name: "Claude subscription" }).click();
  await side.getByText("Not ready yet.").waitFor({ timeout: 10000 }).catch(() => {});
  const subText = await side.locator("body").innerText();
  check("subscription shows a plain readiness message when the Bridge is off", subText.includes("Not ready yet.") && subText.includes("Local Agent Bridge is not connected"));

  await providerBox.click();
  await side.getByRole("option", { name: "LM Studio (local)" }).click();
  check("local provider needs no API key field", (await side.getByLabel("API key").count()) === 0);
  await side.getByLabel("Base URL").fill(`http://localhost:${port}/v1`);
  await side.getByText(/models loaded/).waitFor({ timeout: 15000 }).catch(() => {});
  check("models load from the local server", (await side.locator("body").innerText()).includes("2 models loaded"));

  await side.getByRole("combobox", { name: "Model", exact: true }).fill("qwen2.5-7b-instruct");
  await side.getByRole("button", { name: /Test Chat \+ Agent/ }).click();
  await side.getByText(/^Saved\./).waitFor({ timeout: 30000 }).catch(() => {});
  const saved = await side.locator("body").innerText();
  check("local model passes the Chat and Agent checks and is saved", /Saved\. Chat ✓/.test(saved) && /Agent ✓/.test(saved), saved.match(/Saved\.[^\n]*/)?.[0] || "");
  check("no Authorization header was sent to the local server", seenAuth.length > 0 && seenAuth.every((a) => a === ""));
} finally {
  await ctx.close();
  server.close();
  lmStudio.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} connect checks passed`);
process.exit(failed ? 1 : 0);
