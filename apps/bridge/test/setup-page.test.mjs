import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSetupServer, pairingMessage } from "../src/setup-page.mjs";
import { stableNodePath } from "../src/install.mjs";

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
    assert.match(home.text, /Set up the BrowserHarness helper app/);
    assert.equal((await request(url.replace("s3cret", "guess"))).status, 404);
    assert.equal((await request(`${url}status`, { headers: { host: "evil.example" } })).status, 421, "other host names are refused");
    assert.equal((await request(`${url}status`, { headers: { origin: "https://evil.example" } })).status, 403, "other websites are refused");
    assert.deepEqual((await request(`${url}status`)).json(), { running: true, extension_connected: false });

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
  assert.match(pairingMessage({ code: "BRIDGE_NOT_RUNNING" }).message, /double-click the installer again/);
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
