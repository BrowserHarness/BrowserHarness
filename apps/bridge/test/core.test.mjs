import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import {
  BRIDGE_PROTOCOL_VERSION,
  createBridgeServer
} from "../src/core.mjs";

async function start() {
  const token = "test-token";
  const bridge = createBridgeServer({
    host: "127.0.0.1",
    port: 0,
    token,
    commandTimeoutMs: 1000
  });
  const address = await bridge.listen();
  const base = `http://127.0.0.1:${address.port}`;
  return { bridge, token, base, port: address.port };
}

test("status reports disconnected extension", async () => {
  const env = await start();
  try {
    const response = await fetch(`${env.base}/status`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.running, true);
    assert.equal(body.extension_connected, false);
    assert.equal(body.protocol_version, BRIDGE_PROTOCOL_VERSION);
  } finally {
    await env.bridge.close();
  }
});

test("command endpoint requires pairing token", async () => {
  const env = await start();
  try {
    const response = await fetch(`${env.base}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session: "test",
        action: "observe_page",
        args: {}
      })
    });
    assert.equal(response.status, 401);
  } finally {
    await env.bridge.close();
  }
});

test("relays a command to the connected extension", async () => {
  const env = await start();
  const ws = new WebSocket(
    `ws://127.0.0.1:${env.port}/ws?token=${env.token}`
  );

  try {
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    ws.send(
      JSON.stringify({
        type: "hello",
        protocol_version: BRIDGE_PROTOCOL_VERSION,
        extension_id: "test-extension",
        extension_version: "0.2.0"
      })
    );

    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("hello timeout")),
        1000
      );
      ws.on("message", function onMessage(raw) {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "hello_ack") {
          clearTimeout(timer);
          ws.off("message", onMessage);
          resolve();
        }
      });
    });

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== "command") return;
      ws.send(
        JSON.stringify({
          type: "result",
          id: msg.id,
          ok: true,
          data: {
            action: msg.action,
            session: msg.session
          }
        })
      );
    });

    const response = await fetch(`${env.base}/command`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.token}`
      },
      body: JSON.stringify({
        session: "research-task",
        action: "list_tabs",
        args: {}
      })
    });

    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.data, {
      action: "list_tabs",
      session: "research-task"
    });
  } finally {
    ws.close();
    await env.bridge.close();
  }
});
