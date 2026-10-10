// Shared setup for the local API engine scripts: a throwaway HOME with the
// built Bridge installed, real Chromium with the built extension paired to
// it, and the local fixture shop. Nothing here reaches the internet.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dist = path.join(root, "apps/extension/dist");
const bundle = path.join(root, "apps/bridge/dist/browserharness-bridge.mjs");

export const SESSION_COOKIE = "valid-session-123456";
export const STORAGE_TOKEN = "tok_9fK2mQ7vX1pL8sD4hJ6w";

const lastJson = (text) => {
  try {
    return JSON.parse(text.trim().split("\n").at(-1) || "");
  } catch {
    return null;
  }
};

/** Starts everything; `check(name, ok, detail)` records setup steps. */
export async function startHarness({ check = () => undefined, title = "API engine test" } = {}) {
  for (const file of [path.join(dist, "manifest.json"), bundle]) {
    if (!fs.existsSync(file)) {
      console.error("Build first: npm run build && npm run build:bridge");
      process.exit(2);
    }
  }
  const { chromium } = require("playwright-core");
  const { startApiShop } = await import(path.join(root, "apps/bridge/test/fixtures/api-shop.mjs"));

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
  const currentToken = () => JSON.parse(fs.readFileSync(path.join(home, ".browserharness-bridge", "config.json"), "utf8")).token;
  const command = async (session, action, args = {}) => {
    const started = performance.now();
    const response = await fetch(`http://127.0.0.1:${port}/command`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${currentToken()}` },
      body: JSON.stringify({ session, title, action, args })
    });
    const body = await response.json();
    body.elapsed_ms = Math.round(performance.now() - started);
    return body;
  };

  const shop = await startApiShop();
  let ctx;
  const close = async () => {
    await ctx?.close().catch(() => undefined);
    spawnSync(process.execPath, [bundle, "stop"], { env, timeout: 30_000 });
    spawnSync(process.execPath, [installed, "stop"], { env, timeout: 30_000 });
    await shop.close();
    fs.rmSync(home, { recursive: true, force: true });
  };
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
    return { ctx, side, shop, command, close };
  } catch (error) {
    await close();
    throw error;
  }
}
