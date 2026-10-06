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
let failChat = false;
const handler = (req, res) => {
    seenAuth.push(req.headers.authorization || "");
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/v1/models")) {
      return res.end(JSON.stringify({ data: [{ id: "deepseek-v4-flash-0731" }, { id: "qwen2.5-7b-instruct" }, { id: "text-embedding-nomic" }] }));
    }
    if (req.url.startsWith("/v1/chat/completions") && failChat) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: { message: "invalid api key" } }));
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
  await side.getByRole("button", { name: /^Your AI/ }).click();
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
    await side.getByText(/^All set\./).first().waitFor({ timeout: 30000 }).catch(() => {});
    if (process.env.SHOT_DIR) await side.screenshot({ path: path.join(process.env.SHOT_DIR, "connect-local.png") });
    check("the picked local model is tested and saved", /All set\. This AI can chat with you and use your browser/.test(await side.locator("body").innerText()));

    await side.getByRole("button", { name: "All settings" }).click();
    await side.getByRole("button", { name: "Back to chat" }).click();
    const menuButton = side.getByRole("button", { name: "Choose model" });
    await menuButton.waitFor({ timeout: 10000 });
    await side.waitForFunction(() => document.querySelector("[aria-label=\"Choose model\"]")?.textContent?.includes("deepseek-v4-flash-0731"), null, { timeout: 5000 }).catch(() => {});
    check("chat header shows the picked model", (await menuButton.innerText()).includes("deepseek-v4-flash-0731"), await menuButton.innerText());
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
    failChat = true;
    await composer.fill("write a poem about the hills");
    await composer.press("Enter");
    const failure = side.getByRole("alert").filter({ hasText: /couldn't finish/i });
    await failure.waitFor({ timeout: 30000 }).catch(() => {});
    const failureText = await failure.innerText().catch(() => "");
    check(
      "a failed request in chat shows why, how to fix it and its guide",
      failureText.includes("asked for a key") && failureText.includes("How to fix it") && (await failure.locator('[data-guide="ai-key-rejected"]').count()) === 1,
      failureText.split("\n").slice(0, 2).join(" / ")
    );
    if (process.env.SHOT_DIR) { await side.waitForTimeout(600); await side.screenshot({ path: path.join(process.env.SHOT_DIR, "chat-problem.png") }); }
    failChat = false;
    await failure.getByRole("button", { name: "Try again" }).click();
    await side.waitForFunction(() => document.body.innerText.split("Reply from").length > 2, null, { timeout: 30000 }).catch(() => {});
    check("Try again sends the same request again", (await side.locator("body").innerText()).split("Reply from").length > 2);
    check("the reply comes from the model picked in the menu, thinking hidden", chat.includes("Reply from qwen2.5-7b-instruct") && !chat.includes("planning the reply"), `models called: ${[...new Set(seenModels)].join(", ")}`);

    await side.getByRole("button", { name: "Settings" }).first().click();
    await side.getByRole("button", { name: /^Your AI/ }).click();
    await side.getByText("Connect your AI").waitFor({ timeout: 10000 });
  } else {
    console.log("SKIP local auto-detect and model menu (port 1234 busy)");
  }

  await side.getByRole("button", { name: "Show more ways to connect" }).click();
  const providerBox = side.getByRole("combobox", { name: "Service" });
  await providerBox.waitFor({ timeout: 10000 });
  await providerBox.click();
  const options = (await side.getByRole("option").allInnerTexts()).map((t) => t.trim());
  check(
    "provider list offers subscriptions and local models",
    ["Claude subscription", "ChatGPT subscription", "LM Studio (on this computer)", "Ollama (on this computer)"].every((o) => options.includes(o)),
    options.join(" | ")
  );

  await side.getByRole("option", { name: "Claude subscription" }).click();
  await side.getByText("The helper app isn't connected").waitFor({ timeout: 10000 }).catch(() => {});
  const subText = await side.locator("body").innerText();
  check(
    "subscription explains why it isn't ready, with a fix and a guide, when the helper app is off",
    /not ready yet/i.test(subText) && subText.includes("The helper app isn't connected") && subText.includes("How to fix it") && (await side.locator('[data-guide="helper-not-connected"]').count()) === 1
  );

  await providerBox.click();
  await side.getByRole("option", { name: "LM Studio (on this computer)" }).click();
  check("local provider needs no API key field", (await side.getByLabel("Secret key (API key)").count()) === 0);
  await side.getByLabel("Server address", { exact: true }).fill(`http://localhost:${port}/v1`);
  await side.getByText(/models found/).waitFor({ timeout: 15000 }).catch(() => {});
  check("models load from the local server", (await side.locator("body").innerText()).includes("3 models found"));

  await side.getByRole("combobox", { name: "Model name", exact: true }).fill("qwen2.5-7b-instruct");
  await side.getByRole("button", { name: "Test and save", exact: true }).click();
  await side.getByText(/All set\./).last().waitFor({ timeout: 30000 }).catch(() => {});
  const saved = await side.locator("body").innerText();
  check("local model passes the Chat and Agent checks and is saved", /All set\. This AI can chat with you and use your browser/.test(saved), saved.match(/(All set|Saved|This AI)[^\n]*/)?.[0] || "");
  check("a success tick and Connected banner appear", (await side.getByRole("status").filter({ hasText: "Connected" }).count()) > 0);
  check("the tested AI is listed with plain abilities", saved.includes("AIs you've tested") && saved.includes("Can use the browser"));
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
