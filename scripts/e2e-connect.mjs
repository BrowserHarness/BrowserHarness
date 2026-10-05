#!/usr/bin/env node
// Local real-Chromium test of the Connect AI screen and the chat model menu: every model a local
// (LM Studio style, no key) server has loaded is offered, the user picks one, switches models from the
// chat header, and the reply comes from the picked model. Fake local server, no real model, no network.
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
const seenModels = [];
const handler = (req, res) => {
    seenAuth.push(req.headers.authorization || "");
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/v1/models")) {
      return res.end(JSON.stringify({ data: [{ id: "deepseek-v4-flash-0731" }, { id: "qwen2.5-7b-instruct" }, { id: "text-embedding-nomic" }] }));
    }
    if (req.url.startsWith("/v1/chat/completions")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw);
        const user = String(body.messages.at(-1).content?.[0]?.text ?? body.messages.at(-1).content ?? "");
        const content = user.includes("USER GOAL")
          ? JSON.stringify({ kind: "tool", tool: "click", input: { element_id: "bc-health-1" }, note: "Clicking Continue" })
          : user.includes("OK only")
            ? "OK"
            : `<think>planning the reply</think>Reply from ${body.model}`;
        seenModels.push(body.model);
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
  check("simple screen offers OpenRouter and shows ChatGPT as coming soon", body0.includes("OpenRouter (recommended)") && body0.includes("Coming soon"));
  check("no model is preselected anywhere", !/openrouter\/auto/.test(body0));

  if (lmStudioUp) {
    await side.getByText(/LM Studio found at http:\/\/127\.0\.0\.1:1234/).waitFor({ timeout: 15000 }).catch(() => {});
    const found = await side.locator("body").innerText();
    check("LM Studio is found at 127.0.0.1:1234 with every chat model it has loaded", /LM Studio found at http:\/\/127\.0\.0\.1:1234 \(2 models\)/.test(found), found.match(/LM Studio found[^\n]*/)?.[0] || "");
    const chooser = side.getByRole("combobox", { name: "LM Studio model" });
    await chooser.click();
    const offered = (await side.getByRole("option").allInnerTexts()).map((t) => t.trim());
    check("both loaded models are offered, embeddings are not", offered.includes("deepseek-v4-flash-0731") && offered.includes("qwen2.5-7b-instruct") && !offered.includes("text-embedding-nomic"), offered.join(" | "));
    await side.getByRole("option", { name: "deepseek-v4-flash-0731" }).click();
    await side.getByRole("button", { name: "Use this model" }).first().click();
    await side.getByText(/^Saved\./).first().waitFor({ timeout: 30000 }).catch(() => {});
    if (process.env.SHOT_DIR) await side.screenshot({ path: path.join(process.env.SHOT_DIR, "connect-local.png") });
    check("the picked local model is tested and saved", /Saved\. Chat ✓/.test(await side.locator("body").innerText()));

    await side.getByRole("button", { name: "Back to chat" }).click();
    const menuButton = side.getByRole("button", { name: "Choose model" });
    await menuButton.waitFor({ timeout: 10000 });
    check("chat header shows the picked model", (await menuButton.innerText()).includes("deepseek-v4-flash-0731"));
    await menuButton.click();
    await side.getByRole("button", { name: "qwen2.5-7b-instruct" }).waitFor({ timeout: 10000 }).catch(() => {});
    const menuText = await side.locator(".MuiPopover-paper").innerText().catch(() => "");
    if (process.env.SHOT_DIR) { await side.waitForTimeout(500); await side.screenshot({ path: path.join(process.env.SHOT_DIR, "model-menu.png") }); }
    check("chat model menu lists every model from the connected service", menuText.includes("LM Studio") && menuText.includes("deepseek-v4-flash-0731") && menuText.includes("qwen2.5-7b-instruct") && !menuText.includes("text-embedding-nomic"), menuText.replace(/\n+/g, " | "));
    await side.getByLabel("Search models").fill("qwen");
    check("menu search narrows the list", !(await side.locator(".MuiPopover-paper").innerText()).includes("deepseek-v4-flash-0731"));
    await side.getByRole("button", { name: "qwen2.5-7b-instruct" }).click();
    await side.locator(".MuiPopover-paper").waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
    check("one click switches the chat to another model", (await menuButton.innerText()).includes("qwen2.5-7b-instruct"));

    const composer = side.getByRole("textbox").last();
    await composer.fill("write a short poem about the sea");
    await composer.press("Enter");
    await side.getByText("Reply from qwen2.5-7b-instruct").waitFor({ timeout: 30000 }).catch(() => {});
    const chat = await side.locator("body").innerText();
    check("the reply comes from the model picked in the menu, thinking hidden", chat.includes("Reply from qwen2.5-7b-instruct") && !chat.includes("planning the reply"), `models called: ${[...new Set(seenModels)].join(", ")}`);

    await side.getByRole("button", { name: "Settings" }).first().click();
    await side.getByText("Connect your AI").waitFor({ timeout: 10000 });
  } else {
    console.log("SKIP local auto-detect and model menu (port 1234 busy)");
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
  check("models load from the local server", (await side.locator("body").innerText()).includes("3 models loaded"));

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
