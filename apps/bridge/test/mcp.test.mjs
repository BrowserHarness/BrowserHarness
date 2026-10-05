import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { createBridgeServer } from "../src/core.mjs";
import {
  BROWSERHARNESS_MCP_TOOLS,
  bridgeHttpBase,
  bridgeResultToMcp,
  createBridgeHttpClient
} from "../src/mcp.mjs";

test("MCP tool registry exposes the full Local Bridge action surface", () => {
  const actions = BROWSERHARNESS_MCP_TOOLS.map(
    (tool) => tool.action
  );
  assert.equal(actions.length, 35);
  assert.equal(new Set(actions).size, 35);
  assert.ok(actions.includes("observe_page"));
  assert.ok(actions.includes("memory"));
  assert.ok(actions.includes("site_skill"));
  assert.ok(actions.includes("cdp"));
  assert.ok(actions.includes("close_session"));
});

test("MCP Bridge transport rejects non-loopback configuration", () => {
  assert.throws(
    () =>
      bridgeHttpBase({
        host: "browserharness.example.com",
        port: 10087,
        token: "secret"
      }),
    /loopback/
  );
});

test("MCP Bridge client preserves session, action, args and pairing token", async () => {
  const calls = [];
  const client = createBridgeHttpClient(
    {
      host: "127.0.0.1",
      port: 10087,
      token: "pairing-secret"
    },
    {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({
            ok: true,
            data: { tab_id: 7 }
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }
    }
  );

  const result = await client.command({
    session: "task-123",
    title: "Research phones",
    action: "find",
    args: {
      query: "pricing",
      role: "link"
    }
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "http://127.0.0.1:10087/command"
  );
  assert.equal(
    calls[0].init.headers.authorization,
    "Bearer pairing-secret"
  );
  assert.deepEqual(
    JSON.parse(calls[0].init.body),
    {
      session: "task-123",
      title: "Research phones",
      action: "find",
      args: {
        query: "pricing",
        role: "link"
      }
    }
  );
});

test("MCP result preserves BrowserHarness approval failures", () => {
  const mapped = bridgeResultToMcp({
    ok: false,
    error: {
      code: "APPROVAL_REQUIRED",
      message: "Activate Place order"
    }
  });

  assert.equal(mapped.isError, true);
  const body = JSON.parse(mapped.content[0].text);
  assert.equal(body.ok, false);
  assert.equal(
    body.error.code,
    "APPROVAL_REQUIRED"
  );
});

test("MCP Bridge client propagates approval boundary through the real relay", async () => {
  const token = "test-token";
  const bridge = createBridgeServer({
    host: "127.0.0.1",
    port: 0,
    token,
    commandTimeoutMs: 1000
  });
  const address = await bridge.listen();
  const port = address.port;
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws?token=${token}`
  );

  try {
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    ws.send(
      JSON.stringify({
        type: "hello",
        protocol_version: "0.1",
        extension_id: "test-extension",
        extension_version: "0.3.0"
      })
    );

    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("hello timeout")),
        1000
      );
      ws.on("message", function onMessage(raw) {
        const message = JSON.parse(raw.toString());
        if (message.type !== "hello_ack") return;
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve();
      });
    });

    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "command") return;
      assert.equal(message.session, "checkout-task");
      assert.equal(message.action, "trusted_click");
      ws.send(
        JSON.stringify({
          type: "result",
          id: message.id,
          ok: false,
          error: {
            code: "APPROVAL_REQUIRED",
            message: "Place order requires approval"
          }
        })
      );
    });

    const client = createBridgeHttpClient({
      host: "127.0.0.1",
      port,
      token
    });
    const result = await client.command({
      session: "checkout-task",
      title: "Checkout",
      action: "trusted_click",
      args: {
        element_id: "@e7"
      }
    });

    assert.deepEqual(result, {
      ok: false,
      error: {
        code: "APPROVAL_REQUIRED",
        message: "Place order requires approval"
      }
    });
    assert.equal(
      bridgeResultToMcp(result).isError,
      true
    );
  } finally {
    ws.close();
    await bridge.close();
  }
});

test("MCP status reports Bridge availability without requiring a task session", async () => {
  const client = createBridgeHttpClient(
    {
      host: "127.0.0.1",
      port: 10087,
      token: "secret"
    },
    {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            running: true,
            extension_connected: false,
            protocol_version: "0.1"
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        )
    }
  );

  const result = await client.status();
  assert.equal(result.ok, true);
  assert.equal(
    result.data.extension_connected,
    false
  );
});

test("MCP shows pages as compact text, and the page after an action", () => {
  const page = {
    tab_id: 3,
    url: "https://example.com/",
    title: "Example",
    visible_text: "Hello   world",
    elements: [
      { element_id: "@e1", role: "button", accessible_name: "Save", tag: "button", disabled: false },
      { element_id: "@e2", role: "link", accessible_name: "Far", tag: "a", in_viewport: false, requires_approval: true }
    ]
  };
  const observed = bridgeResultToMcp({ ok: true, data: page });
  assert.equal(observed.content.length, 1);
  assert.match(observed.content[0].text, /^tab_id: 3\nurl: https:\/\/example.com\//);
  assert.match(observed.content[0].text, /@e1 button "Save" <button>\n@e2 link "Far" <a> \[offscreen,approval-required\]/);
  assert.match(observed.content[0].text, /visible text:\nHello world$/);

  const clicked = bridgeResultToMcp({ ok: true, data: { clicked: true }, page });
  assert.deepEqual(JSON.parse(clicked.content[0].text), { ok: true, data: { clicked: true } });
  assert.match(clicked.content[1].text, /^Page after this action:\ntab_id: 3/);
});

test("MCP sends screenshots as images", () => {
  const mapped = bridgeResultToMcp({
    ok: true,
    data: { mode: "viewport", data_url: "data:image/png;base64,iVBORw0KGgo=" }
  });
  assert.deepEqual(JSON.parse(mapped.content[0].text), { ok: true, data: { mode: "viewport" } });
  assert.deepEqual(mapped.content[1], { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" });
});
