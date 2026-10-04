import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import {
  BRIDGE_PROTOCOL_VERSION,
  createBridgeServer
} from "../src/core.mjs";

async function start(options = {}) {
  const token = "test-token";
  const bridge = createBridgeServer({
    host: "127.0.0.1",
    port: 0,
    token,
    commandTimeoutMs: 1000,
    ...options
  });
  const address = await bridge.listen();
  const base = `http://127.0.0.1:${address.port}`;
  return { bridge, token, base, port: address.port };
}

function waitForWsMessage(ws, predicate, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("WebSocket message timeout"));
    }, timeoutMs);

    function onMessage(raw) {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(message);
    }

    ws.on("message", onMessage);
  });
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


test("outbound MCP endpoints require pairing token", async () => {
  const env = await start({
    mcpManager: {
      listServers: async () => [],
      closeAll: async () => undefined
    }
  });
  try {
    const response = await fetch(
      `${env.base}/mcp/servers`
    );
    assert.equal(response.status, 401);
  } finally {
    await env.bridge.close();
  }
});

test("Bridge exposes authenticated outbound MCP discovery and calls", async () => {
  let closed = false;
  const mcpManager = {
    listServers: async () => [
      {
        id: "notes",
        label: "Notes",
        transport: "stdio",
        enabled: true,
        connected: false,
        env_keys: ["NOTES_TOKEN"]
      }
    ],
    listTools: async (serverId) => {
      assert.equal(serverId, "notes");
      return {
        server: {
          id: "notes",
          label: "Notes",
          transport: "stdio",
          enabled: true,
          connected: true,
          env_keys: ["NOTES_TOKEN"]
        },
        tools: [
          {
            name: "search_notes",
            description: "Search notes",
            inputSchema: {
              type: "object"
            },
            annotations: {
              readOnlyHint: true
            }
          }
        ]
      };
    },
    callTool: async (serverId, tool, args) => {
      assert.equal(serverId, "notes");
      assert.equal(tool, "search_notes");
      assert.deepEqual(args, { query: "BrowserHarness" });
      return {
        server_id: serverId,
        tool,
        annotations: {
          readOnlyHint: true
        },
        result: {
          content: [
            {
              type: "text",
              text: "Found BrowserHarness"
            }
          ]
        }
      };
    },
    closeAll: async () => {
      closed = true;
    }
  };

  const env = await start({ mcpManager });
  const auth = {
    authorization: `Bearer ${env.token}`
  };

  try {
    const status = await fetch(`${env.base}/status`);
    const statusBody = await status.json();
    assert.equal(statusBody.mcp_client_enabled, true);
    assert.equal(statusBody.mcp_servers_configured, 1);

    const servers = await fetch(
      `${env.base}/mcp/servers`,
      { headers: auth }
    );
    const serversBody = await servers.json();
    assert.equal(servers.status, 200);
    assert.equal(serversBody.ok, true);
    assert.equal(
      serversBody.data.servers[0].id,
      "notes"
    );
    assert.equal(
      JSON.stringify(serversBody).includes("secret-value"),
      false
    );

    const tools = await fetch(
      `${env.base}/mcp/list-tools`,
      {
        method: "POST",
        headers: {
          ...auth,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          server_id: "notes"
        })
      }
    );
    const toolsBody = await tools.json();
    assert.equal(tools.status, 200);
    assert.equal(
      toolsBody.data.tools[0].annotations.readOnlyHint,
      true
    );

    const call = await fetch(
      `${env.base}/mcp/call-tool`,
      {
        method: "POST",
        headers: {
          ...auth,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          server_id: "notes",
          tool: "search_notes",
          arguments: {
            query: "BrowserHarness"
          }
        })
      }
    );
    const callBody = await call.json();
    assert.equal(call.status, 200);
    assert.equal(callBody.ok, true);
    assert.equal(
      callBody.data.result.content[0].text,
      "Found BrowserHarness"
    );
  } finally {
    await env.bridge.close();
  }

  assert.equal(closed, true);
});


test("paired extension reverse MCP RPC preserves approval boundary", async () => {
  const mcpManager = {
    listServers: async () => [],
    listTools: async () => ({
      server: {
        id: "notes",
        label: "Notes",
        enabled: true,
        transport: "stdio",
        connected: true,
        env_keys: []
      },
      tools: [
        {
          name: "write_note",
          annotations: {
            readOnlyHint: false,
            destructiveHint: true
          }
        }
      ]
    }),
    callTool: async (
      serverId,
      tool,
      args,
      { allowMutating = false } = {}
    ) => {
      assert.equal(serverId, "notes");
      assert.equal(tool, "write_note");
      assert.deepEqual(args, { text: "hello" });

      if (!allowMutating) {
        throw new Error(
          "MCP_APPROVAL_REQUIRED: notes/write_note"
        );
      }

      return {
        server_id: serverId,
        tool,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true
        },
        result: {
          content: [
            {
              type: "text",
              text: "saved"
            }
          ]
        }
      };
    },
    closeAll: async () => undefined
  };

  const env = await start({ mcpManager });
  const ws = new WebSocket(
    `ws://127.0.0.1:${env.port}/ws?token=${env.token}`
  );

  try {
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    const hello = waitForWsMessage(
      ws,
      (message) => message.type === "hello_ack"
    );
    ws.send(
      JSON.stringify({
        type: "hello",
        protocol_version: BRIDGE_PROTOCOL_VERSION,
        extension_id: "test-extension",
        extension_version: "0.3.0"
      })
    );
    await hello;

    const denied = waitForWsMessage(
      ws,
      (message) =>
        message.type === "mcp_result" &&
        message.id === "mcp-denied"
    );
    ws.send(
      JSON.stringify({
        type: "mcp_request",
        id: "mcp-denied",
        action: "call_tool",
        approved: false,
        args: {
          server_id: "notes",
          tool: "write_note",
          arguments: {
            text: "hello"
          }
        }
      })
    );

    const deniedResult = await denied;
    assert.equal(deniedResult.ok, false);
    assert.equal(
      deniedResult.error.code,
      "APPROVAL_REQUIRED"
    );

    const approved = waitForWsMessage(
      ws,
      (message) =>
        message.type === "mcp_result" &&
        message.id === "mcp-approved"
    );
    ws.send(
      JSON.stringify({
        type: "mcp_request",
        id: "mcp-approved",
        action: "call_tool",
        approved: true,
        args: {
          server_id: "notes",
          tool: "write_note",
          arguments: {
            text: "hello"
          }
        }
      })
    );

    const approvedResult = await approved;
    assert.equal(approvedResult.ok, true);
    assert.equal(
      approvedResult.data.result.content[0].text,
      "saved"
    );
  } finally {
    ws.close();
    await env.bridge.close();
  }
});
