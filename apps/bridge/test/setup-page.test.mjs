import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSetupServer, pairingMessage } from "../src/setup-page.mjs";
import { installContext, stableNodePath } from "../src/install.mjs";
import { findAppBrowser, icnsFromPng, icoFromPng, installShortcuts, shortcutPaths, uninstallShortcuts } from "../src/helper-window.mjs";

/** A raw request, so the Host and Origin headers can be set freely. */
function request(url, { method = "GET", headers = {}, body } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: target.port, path: target.pathname, method, headers: { host: target.host, ...headers } },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }));
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("the setup page answers only on its secret address, from itself", async () => {
  const approved = [];
  const page = createSetupServer({
    secret: "s3cret",
    status: async () => ({ running: true, extension_connected: false }),
    approve: async (code) => (approved.push(code), { ok: true })
  });
  const url = await page.listen();
  try {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/s3cret\/$/);
    const home = await request(url);
    assert.equal(home.status, 200);
    assert.match(home.text, /<title>BrowserHarness Helper<\/title>/);
    assert.equal((await request(url.replace("s3cret", "guess"))).status, 404);
    assert.equal((await request(`${url}status`, { headers: { host: "evil.example" } })).status, 421, "other host names are refused");
    assert.equal((await request(`${url}status`, { headers: { origin: "https://evil.example" } })).status, 403, "other websites are refused");
    assert.deepEqual((await request(`${url}status`)).json(), { running: true, extension_connected: false, can_control: false });

    const post = (body, type = "application/json") =>
      request(`${url}pair`, { method: "POST", headers: { "content-type": type, origin: new URL(url).origin }, body });
    assert.equal((await post("code=123456", "application/x-www-form-urlencoded")).status, 415, "plain form posts are refused");
    assert.equal((await post(JSON.stringify({ code: "12" }))).json().code, "BAD_CODE");
    assert.equal((await post(JSON.stringify({ code: "123 456" }))).json().ok, true);
    assert.deepEqual(approved, ["123456"]);
  } finally {
    await page.close();
  }
});

test("pairing failures are explained in plain words", () => {
  assert.match(pairingMessage({ ok: false, error: { code: "PAIRING_CODE_NOT_FOUND" } }).message, /press Pair again/);
  assert.match(pairingMessage({ code: "BRIDGE_NOT_RUNNING" }).message, /Press Start/);
  assert.deepEqual(pairingMessage({ ok: true }), { ok: true });
});

test("a bundled Node is copied next to the helper app; a system Node is left alone", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "bh-node-"));
  try {
    const fake = path.join(home, "Downloads", "node");
    await mkdir(path.dirname(fake), { recursive: true });
    await writeFile(fake, "fake node");
    assert.equal(await stableNodePath({ nodePath: fake, home, bundledRuntime: false, platform: "linux" }), fake);
    const copied = await stableNodePath({ nodePath: fake, home, bundledRuntime: true, platform: "linux" });
    assert.equal(copied, path.join(home, ".browserharness-bridge", "runtime", "node"));
    assert.equal(await readFile(copied, "utf8"), "fake node");
    assert.equal(await stableNodePath({ nodePath: fake, home, bundledRuntime: true, platform: "win32" }), path.join(home, ".browserharness-bridge", "runtime", "node.exe"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the window's buttons reach only the actions it was given, as JSON from itself", async () => {
  const calls = [];
  const page = createSetupServer({
    secret: "w1ndow",
    status: async () => ({ running: false }),
    approve: async () => ({ ok: true }),
    actions: {
      start: async (body) => (calls.push(["start", body]), { ok: true }),
      login: async (body) => (calls.push(["login", body]), { ok: true })
    }
  });
  const url = await page.listen();
  const origin = new URL(url).origin;
  const post = (route, body, headers = {}) =>
    request(`${url}${route}`, { method: "POST", headers: { "content-type": "application/json", origin, ...headers }, body });
  try {
    assert.equal((await request(`${url}status`)).json().can_control, true);
    assert.equal(page.wasOpened(), true);
    assert.equal((await post("do/start", "{}")).json().ok, true);
    assert.equal((await post("do/login", JSON.stringify({ on: false }))).json().ok, true);
    assert.deepEqual(calls, [["start", {}], ["login", { on: false }]]);
    assert.equal((await post("do/uninstall", "{}")).status, 404, "unknown actions are refused");
    assert.equal((await post("do/toString", "{}")).status, 404, "built-in names are not actions");
    assert.equal((await post("do/start", "{}", { origin: "https://evil.example" })).status, 403);
    assert.equal((await post("do/start", "x", { "content-type": "text/plain" })).status, 415);
    assert.equal(calls.length, 2);

    assert.equal(page.closedByPerson(), false);
    assert.equal((await request(`${url}bye`, { method: "POST", headers: { origin } })).status, 204);
    assert.equal(page.closedByPerson(), false, "not until a few seconds pass with no reload");
  } finally {
    await page.close();
  }
});

test("the icon files carry the PNG inside the right header", () => {
  const png = Buffer.from("89504e470d0a1a0a00", "hex");
  const ico = icoFromPng(png);
  assert.deepEqual([...ico.subarray(0, 6)], [0, 0, 1, 0, 1, 0]);
  assert.equal(ico.readUInt8(6), 128);
  assert.equal(ico.readUInt32LE(14), png.length);
  assert.equal(ico.readUInt32LE(18), 22);
  assert.deepEqual(ico.subarray(22), png);
  const icns = icnsFromPng(png);
  assert.equal(icns.subarray(0, 4).toString(), "icns");
  assert.equal(icns.readUInt32BE(4), icns.length);
  assert.equal(icns.subarray(8, 12).toString(), "ic07");
  assert.deepEqual(icns.subarray(16), png);
});

test("the BrowserHarness Helper shortcut opens the window on each computer, and goes away on uninstall", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "bh-shortcut-"));
  const ran = [];
  const make = (platform, env = {}) =>
    installContext({
      home,
      platform,
      env,
      nodePath: "/opt/it's/node",
      cliPath: "/home/me/.browserharness-bridge/bin/browserharness-bridge.mjs",
      run: (command, args) => (ran.push([command, ...args]), { code: 0, stdout: "", stderr: "" }),
      which: () => null
    });
  try {
    const linux = make("linux", {});
    const desktop = await installShortcuts(linux);
    assert.equal(desktop.created, true);
    const entry = await readFile(shortcutPaths(linux).file, "utf8");
    assert.match(entry, /^Name=BrowserHarness Helper$/m);
    assert.match(entry, /^Exec="\/opt\/it's\/node" "\/home\/me\/\.browserharness-bridge\/bin\/browserharness-bridge\.mjs" app$/m);
    assert.match(entry, /^Terminal=false$/m);
    assert.equal((await readFile(path.join(home, ".browserharness-bridge", "bin", "helper.png"))).subarray(1, 4).toString(), "PNG");
    await uninstallShortcuts(linux);
    await assert.rejects(readFile(shortcutPaths(linux).file));

    const mac = make("darwin");
    await installShortcuts(mac);
    const appDir = shortcutPaths(mac).app;
    assert.equal(appDir, path.join(home, "Applications", "BrowserHarness Helper.app"));
    const exe = await readFile(path.join(appDir, "Contents", "MacOS", "browserharness-helper"), "utf8");
    assert.match(exe, /exec '\/opt\/it'\\''s\/node' '.*browserharness-bridge\.mjs' app/);
    assert.match(await readFile(path.join(appDir, "Contents", "Info.plist"), "utf8"), /<key>CFBundleExecutable<\/key><string>browserharness-helper<\/string>/);
    assert.equal((await readFile(path.join(appDir, "Contents", "Resources", "helper.icns"))).subarray(0, 4).toString(), "icns");
    await uninstallShortcuts(mac);
    await assert.rejects(readFile(path.join(appDir, "Contents", "Info.plist")));

    const windows = make("win32", { APPDATA: path.join(home, "AppData", "Roaming") });
    const result = await installShortcuts(windows);
    assert.equal(result.created, true);
    const vbs = await readFile(shortcutPaths(windows).launcher, "utf8");
    assert.match(vbs, /Run """\/opt\/it's\/node"" "".*browserharness-bridge\.mjs"" app", 0, False/);
    const call = ran.find((args) => args[0] === "powershell.exe");
    assert.ok(call && call.includes("-File"), "PowerShell makes the Start menu and desktop shortcuts");
    assert.equal((await readFile(path.join(home, ".browserharness-bridge", "bin", "helper.ico"))).readUInt16LE(2), 1);
    await uninstallShortcuts(windows);
    await assert.rejects(readFile(shortcutPaths(windows).launcher));
    assert.equal(ran.filter((args) => args[0] === "powershell.exe").length, 2, "and removes them again");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the window opens in Chrome or Edge when one is found", () => {
  assert.equal(findAppBrowser({ platform: "linux", which: (name) => (name === "chromium" ? "/usr/bin/chromium" : null) }), "/usr/bin/chromium");
  assert.equal(findAppBrowser({ platform: "linux", which: () => null }), null);
  assert.equal(findAppBrowser({ platform: "win32", env: {} }), null);
});

test("the window's icon is the extension's icon", async () => {
  const source = await readFile(new URL("../src/helper-window.mjs", import.meta.url), "utf8");
  const embedded = Buffer.from(source.match(/Buffer\.from\(\n  "([^"]+)"/)[1], "base64");
  assert.deepEqual(embedded, await readFile(new URL("../../extension/public/icons/icon128.png", import.meta.url)));
});
