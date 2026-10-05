import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { createBridgeServer } from "../src/core.mjs";
import {
  createPairingManager,
  extensionIdFromOrigin
} from "../src/pairing.mjs";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

async function start() {
  const token = "pairing-test-token";
  const bridge = createBridgeServer({ host: "127.0.0.1", port: 0, token });
  const address = await bridge.listen();
  return { bridge, token, base: `http://127.0.0.1:${address.port}`, port: address.port };
}

function post(base, path, body, headers = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body || {})
  });
}

test("extension origin parsing accepts only Chrome extension ids", () => {
  assert.equal(extensionIdFromOrigin(EXTENSION_ORIGIN), EXTENSION_ID);
  assert.equal(extensionIdFromOrigin("https://evil.example"), "");
  assert.equal(extensionIdFromOrigin("chrome-extension://short"), "");
  assert.equal(extensionIdFromOrigin(undefined), "");
});

test("pairing hands the token out once, after the code is approved", () => {
  let time = 1000;
  const pairing = createPairingManager({
    token: "secret",
    now: () => time,
    makeCode: () => "123456"
  });
  const request = pairing.request({ extensionId: EXTENSION_ID });
  assert.equal(request.code, "123456");
  assert.deepEqual(pairing.poll(request.request_id, EXTENSION_ID).state, "pending");
  assert.equal(pairing.approve("000000"), null);
  assert.ok(pairing.approve("123 456"));
  assert.equal(pairing.poll(request.request_id, "otherextensionidotherextensionid").state, "expired");
  assert.deepEqual(pairing.poll(request.request_id, EXTENSION_ID), {
    state: "approved",
    token: "secret"
  });
  assert.equal(pairing.poll(request.request_id, EXTENSION_ID).state, "expired");
  time += 10;
});

test("pairing requests expire and too many wrong codes clear them", () => {
  let time = 0;
  let next = 0;
  const pairing = createPairingManager({
    token: "secret",
    ttlMs: 1000,
    now: () => time,
    makeCode: () => String(111111 * ++next)
  });
  const first = pairing.request({ extensionId: EXTENSION_ID });
  time = 1001;
  assert.equal(pairing.poll(first.request_id, EXTENSION_ID).state, "expired");
  pairing.request({ extensionId: EXTENSION_ID });
  for (let attempt = 0; attempt < 5; attempt += 1) pairing.approve("999999");
  assert.deepEqual(pairing.pending(), []);
});

test("the Bridge pairs the extension through a code confirmed with the token", async () => {
  const env = await start();
  try {
    const requested = await (
      await post(env.base, "/pair/request", {}, { origin: EXTENSION_ORIGIN })
    ).json();
    assert.equal(requested.ok, true);
    assert.match(requested.data.code, /^\d{6}$/);

    const pendingWithoutToken = await post(env.base, "/pair/pending");
    assert.equal(pendingWithoutToken.status, 401);
    const pendingFromExtension = await post(
      env.base,
      "/pair/pending",
      {},
      { origin: EXTENSION_ORIGIN, authorization: `Bearer ${env.token}` }
    );
    assert.equal(pendingFromExtension.status, 401);

    const auth = { authorization: `Bearer ${env.token}` };
    const pending = await (await post(env.base, "/pair/pending", {}, auth)).json();
    assert.equal(pending.data.requests.length, 1);
    assert.equal(pending.data.requests[0].extension_id, EXTENSION_ID);

    const wrong = await post(env.base, "/pair/approve", { code: "not-it" }, auth);
    assert.equal(wrong.status, 404);
    const approved = await post(
      env.base,
      "/pair/approve",
      { code: requested.data.code },
      auth
    );
    assert.equal(approved.status, 200);

    const status = await (
      await post(
        env.base,
        "/pair/status",
        { request_id: requested.data.request_id },
        { origin: EXTENSION_ORIGIN }
      )
    ).json();
    assert.deepEqual(status.data, { state: "approved", token: env.token });
  } finally {
    await env.bridge.close();
  }
});

test("web pages cannot ask to pair or reach the Bridge", async () => {
  const env = await start();
  try {
    const fromPage = await post(env.base, "/pair/request", {}, { origin: "https://evil.example" });
    assert.equal(fromPage.status, 403);
    const fromProgram = await post(env.base, "/pair/request", {});
    assert.equal(fromProgram.status, 403);
    const status = await fetch(`${env.base}/status`, {
      headers: { origin: "http://localhost.evil.example" }
    });
    assert.equal(status.status, 403);

    const rejected = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${env.port}/ws?token=${env.token}`, {
        origin: "https://evil.example"
      });
      ws.on("open", () => {
        ws.close();
        resolve(false);
      });
      ws.on("error", () => resolve(true));
    });
    assert.equal(rejected, true);
  } finally {
    await env.bridge.close();
  }
});
