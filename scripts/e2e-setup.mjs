#!/usr/bin/env node
// The double-click helper app download, end to end: unzip the Linux download,
// run its launcher's command with the Node inside it, pair from the setup page
// in the browser (no terminal typing) and check Chrome connects.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "apps/extension/dist");
const zip = path.join(root, "apps/bridge/dist/downloads/browserharness-helper-linux.zip");
if (!fs.existsSync(zip) || !fs.existsSync(path.join(dist, "manifest.json"))) {
  console.error("Build first: npm run build && npm run build:bridge && npm run package:helper -- --only linux");
  process.exit(2);
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const shot = async (page, name) => {
  if (process.env.SHOT_DIR) await page.screenshot({ path: path.join(process.env.SHOT_DIR, `${name}.png`) });
};

// A person's computer: an empty home folder and the unzipped download.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "bh-setup-home-"));
const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "bh-setup-dl-"));
spawnSync("unzip", ["-q", zip, "-d", downloads]);
const folder = path.join(downloads, "BrowserHarness Helper");
const port = 10_800 + Math.floor(Math.random() * 500);
fs.mkdirSync(path.join(home, ".browserharness-bridge"));
fs.writeFileSync(
  path.join(home, ".browserharness-bridge", "config.json"),
  JSON.stringify({ host: "127.0.0.1", port, allow_remote: false, token: "setup-" + Math.random().toString(36).slice(2) })
);
const env = { ...process.env, HOME: home, USERPROFILE: home, BROWSERHARNESS_BUNDLED_NODE: "1" };
delete env.NODE_OPTIONS;

check(
  "the download has the launcher, the helper app, Node and a read-me",
  ["Install BrowserHarness Helper.sh", "browserharness-bridge.mjs", "runtime/node", "runtime/NODE-LICENSE.txt", "READ ME FIRST.txt"].every((file) => fs.existsSync(path.join(folder, file))) &&
    (fs.statSync(path.join(folder, "Install BrowserHarness Helper.sh")).mode & 0o111) !== 0
);
const launcher = fs.readFileSync(path.join(folder, "Install BrowserHarness Helper.sh"), "utf8");
check("the launcher uses the Node inside the download", launcher.includes("./runtime/node ./browserharness-bridge.mjs setup --detach"));

// What the launcher runs, minus opening a browser and the login service.
const setup = spawn(path.join(folder, "runtime/node"), [path.join(folder, "browserharness-bridge.mjs"), "setup", "--no-open", "--no-service", "--json"], { env, cwd: folder });
let output = "";
setup.stdout.on("data", (chunk) => (output += chunk));
setup.stderr.on("data", (chunk) => (output += chunk));
const exited = new Promise((resolve) => setup.on("close", resolve));
const deadline = Date.now() + 30_000;
let info = null;
while (!info && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  for (const line of output.split("\n")) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.setup_url) info = parsed;
    } catch {}
  }
}
check("setup installs quietly and gives a setup page address", Boolean(info?.setup_url) && info.installed === true, output.trim().split("\n").at(-1));
const runtimeNode = path.join(home, ".browserharness-bridge", "runtime", "node");
check("Node is copied next to the helper app, so the download can be deleted", fs.existsSync(runtimeNode));
const desktopEntry = path.join(home, ".local", "share", "applications", "browserharness-helper.desktop");
check(
  "a BrowserHarness Helper entry is added to the apps menu, opening the window",
  fs.existsSync(desktopEntry) && /^Exec=.*browserharness-bridge\.mjs" app$/m.test(fs.readFileSync(desktopEntry, "utf8"))
);
const pid = Number(fs.readFileSync(path.join(home, ".browserharness-bridge", "daemon.pid"), "utf8").trim() || 0);
const daemonExe = pid ? fs.readlinkSync(`/proc/${pid}/exe`) : "";
check("the helper app runs on that copied Node", daemonExe === runtimeNode, daemonExe);

let ctx;
let appProcess;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bh-setup-chrome-"));
try {
  ctx = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME || "/opt/pw-browsers/chromium",
    headless: false,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--headless=new", "--no-sandbox"]
  });
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const extId = sw.url().split("/")[2];
  const side = await ctx.newPage();
  await side.setViewportSize({ width: 430, height: 1100 });
  await side.goto(`chrome-extension://${extId}/sidepanel.html`);
  await side.evaluate((address) => chrome.storage.local.set({ "browserharness.bridgeSettings": { enabled: false, address, token: "" } }), `ws://127.0.0.1:${port}/ws`);
  await side.reload();
  await side.getByRole("button", { name: "Settings" }).first().click();
  await side.getByRole("button", { name: /^Helper app/ }).click();
  const helperText = await side.locator("body").innerText();
  check("Settings explains the double-click download, with no terminal step", helperText.includes("Install BrowserHarness Helper") && !/Terminal|bash install/.test(helperText));
  await shot(side, "helper-settings");
  await side.getByRole("button", { name: "Pair", exact: true }).click();
  const code = (await side.getByLabel("Pairing code").innerText({ timeout: 10000 })).replace(/\D/g, "");

  const page = await ctx.newPage();
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto(info.setup_url);
  await page.locator("#runTitle", { hasText: "Running" }).waitFor({ timeout: 10000 }).catch(() => {});
  check("the helper window shows the helper app is running", (await page.locator("#runTitle").innerText()) === "Running");
  check("it shows whether the Claude and ChatGPT plans can be used", (await page.locator("#plansCard").innerText()).includes("ChatGPT plan (Codex)"));
  await shot(page, "setup-page");
  await page.getByLabel("Pairing code").fill(code === "000000" ? "111111" : "000000");
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByRole("alert").waitFor({ timeout: 10000 }).catch(() => {});
  check("a wrong code says why and what to do", (await page.getByRole("alert").innerText().catch(() => "")).includes("press Pair again"));
  await page.getByLabel("Pairing code").fill(code);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("#done").waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
  check("the right code connects, and the page says so", await page.locator("#done").isVisible());
  await shot(page, "setup-connected");
  await side.bringToFront();
  await side.getByText("The helper app is running and paired with this Chrome.").waitFor({ timeout: 15000 }).catch(() => {});
  check("BrowserHarness shows Connected too", await side.getByText("The helper app is running and paired with this Chrome.").isVisible());

  const code0 = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("still running"), 20000))]);
  check("the installer window finishes by itself", code0 === 0 && output.includes("Connected. You can close this window."), String(code0));

  // Later: the person opens BrowserHarness Helper from their apps.
  const installedCli = path.join(home, ".browserharness-bridge", "bin", "browserharness-bridge.mjs");
  appProcess = spawn(runtimeNode, [installedCli, "app", "--no-open", "--json"], { env, cwd: home });
  let appOutput = "";
  appProcess.stdout.on("data", (chunk) => (appOutput += chunk));
  let windowUrl = "";
  for (let i = 0; i < 100 && !windowUrl; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    windowUrl = appOutput.match(/"window_url":"([^"]+)"/)?.[1] || "";
  }
  check("the BrowserHarness Helper shortcut opens the window", Boolean(windowUrl));
  const again = spawnSync(runtimeNode, [installedCli, "app", "--no-open", "--json"], { env, encoding: "utf8", timeout: 15000 });
  check("opening it twice brings back the same window", again.stdout.includes(`"window_url":"${windowUrl}"`) && again.stdout.includes('"reused":true'));
  const win = await ctx.newPage();
  await win.setViewportSize({ width: 600, height: 900 });
  await win.goto(windowUrl);
  await win.locator("#done").waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  check("the window shows it's connected to Chrome", await win.locator("#done").isVisible());
  await shot(win, "helper-window");
  await win.getByRole("button", { name: "Stop" }).click();
  await win.locator("#runTitle", { hasText: "Stopped" }).waitFor({ timeout: 15000 }).catch(() => {});
  check("Stop stops the helper app, and the window says so", (await win.locator("#runTitle").innerText()) === "Stopped");
  await shot(win, "helper-window-stopped");
  await win.getByRole("button", { name: "Start" }).click();
  await win.locator("#runTitle", { hasText: "Running" }).waitFor({ timeout: 15000 }).catch(() => {});
  check("Start starts it again", (await win.locator("#runTitle").innerText()) === "Running");
  await win.locator("#done").waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
  check("Chrome connects again by itself", await win.locator("#done").isVisible());
  const loginSwitch = win.getByRole("switch", { name: "Start when I turn on my computer" });
  const until = async (test, ms = 15000) => {
    for (const stop = Date.now() + ms; Date.now() < stop; await win.waitForTimeout(250)) if (await test()) return true;
    return false;
  };
  const loginBefore = await loginSwitch.isChecked();
  await loginSwitch.click();
  const switched = await until(async () => (await win.locator("#runMsg").isVisible()) && (await loginSwitch.isChecked()) !== loginBefore);
  const loginMsg = await win.locator("#runMsg").innerText().catch(() => "");
  check("the start-at-login switch changes and says what it did", switched && loginMsg.length > 0, `${loginBefore} -> ${await loginSwitch.isChecked()}: ${loginMsg}`);
  await until(async () => (await win.locator("#runTitle").innerText()) === "Running" && !(await loginSwitch.isDisabled()));
  await loginSwitch.click();
  check("and changes back", await until(async () => (await loginSwitch.isChecked()) === loginBefore));
  await until(async () => (await win.locator("#runTitle").innerText()) === "Running" && !(await loginSwitch.isDisabled()));
  await win.close();
  const appExit = await Promise.race([new Promise((resolve) => appProcess.on("close", resolve)), new Promise((resolve) => setTimeout(() => resolve("still running"), 15000))]);
  const after = spawnSync(runtimeNode, [installedCli, "status"], { env, encoding: "utf8" }).stdout;
  check("closing the window ends it, and the helper keeps running", appExit === 0 && JSON.parse(after || "{}").running === true, `${appExit} ${after}`);
  if (!after.includes("true")) console.log(fs.readFileSync(path.join(home, ".browserharness-bridge", "logs", "daemon.log"), "utf8").slice(-1500));
} finally {
  await ctx?.close();
  setup.kill();
  appProcess?.kill();
  spawnSync(runtimeNode, [path.join(home, ".browserharness-bridge", "bin", "browserharness-bridge.mjs"), "stop"], { env, timeout: 15000 });
  for (const dir of [home, downloads, profile]) fs.rmSync(dir, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} setup checks passed`);
process.exit(failed ? 1 : 0);
