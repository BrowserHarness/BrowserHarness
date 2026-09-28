import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

export const BRIDGE_PROTOCOL_VERSION = "0.1";

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

async function readJson(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new Error("Request body too large");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function authorized(req, token) {
  return req.headers.authorization === `Bearer ${token}`;
}

function normalizeCommand(body) {
  if (!body || typeof body !== "object") {
    throw new Error("Command body must be an object");
  }
  if (typeof body.session !== "string" || !body.session.trim()) {
    throw new Error("session is required");
  }
  if (typeof body.action !== "string" || !body.action.trim()) {
    throw new Error("action is required");
  }
  if (
    body.args !== undefined &&
    (!body.args || typeof body.args !== "object" || Array.isArray(body.args))
  ) {
    throw new Error("args must be an object");
  }

  return {
    session: body.session.trim(),
    action: body.action.trim(),
    args: body.args || {},
    title:
      typeof body.title === "string" && body.title.trim()
        ? body.title.trim()
        : body.session.trim()
  };
}

export function createBridgeServer({
  host = "127.0.0.1",
  port = 10087,
  token,
  commandTimeoutMs = 30_000,
  mcpManager = null
} = {}) {
  if (!token) throw new Error("Bridge pairing token is required");
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("BrowserCrew Bridge must bind to loopback");
  }

  const startedAt = Date.now();
  let extension = null;
  let extensionMeta = null;
  const pending = new Map();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${host}`);

      if (req.method === "GET" && url.pathname === "/status") {
        const configuredMcpServers = mcpManager
          ? await mcpManager
              .listServers()
              .then((servers) => servers.length)
              .catch(() => 0)
          : 0;
        json(res, 200, {
          running: true,
          protocol_version: BRIDGE_PROTOCOL_VERSION,
          uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
          extension_connected:
            extension?.readyState === WebSocket.OPEN,
          extension_id: extensionMeta?.extension_id || "",
          extension_version: extensionMeta?.extension_version || "",
          mcp_client_enabled: Boolean(mcpManager),
          mcp_servers_configured: configuredMcpServers
        });
        return;
      }

      if (
        url.pathname.startsWith("/mcp/") &&
        !authorized(req, token)
      ) {
        json(res, 401, {
          ok: false,
          error: {
            code: "UNAUTHORIZED",
            message: "Invalid BrowserCrew Bridge token"
          }
        });
        return;
      }

      if (
        req.method === "GET" &&
        url.pathname === "/mcp/servers"
      ) {
        if (!mcpManager) {
          json(res, 503, {
            ok: false,
            error: {
              code: "MCP_CLIENT_UNAVAILABLE",
              message:
                "BrowserCrew Bridge MCP client is not enabled"
            }
          });
          return;
        }

        try {
          json(res, 200, {
            ok: true,
            data: {
              servers: await mcpManager.listServers()
            }
          });
        } catch (error) {
          json(res, 502, {
            ok: false,
            error: {
              code: "MCP_CLIENT_FAILED",
              message:
                error instanceof Error
                  ? error.message
                  : String(error)
            }
          });
        }
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname === "/mcp/list-tools"
      ) {
        if (!mcpManager) {
          json(res, 503, {
            ok: false,
            error: {
              code: "MCP_CLIENT_UNAVAILABLE",
              message:
                "BrowserCrew Bridge MCP client is not enabled"
            }
          });
          return;
        }

        try {
          const body = await readJson(req);
          if (
            typeof body.server_id !== "string" ||
            !body.server_id.trim()
          ) {
            throw new Error("server_id is required");
          }
          json(res, 200, {
            ok: true,
            data: await mcpManager.listTools(
              body.server_id.trim()
            )
          });
        } catch (error) {
          json(res, 502, {
            ok: false,
            error: {
              code: "MCP_CLIENT_FAILED",
              message:
                error instanceof Error
                  ? error.message
                  : String(error)
            }
          });
        }
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname === "/mcp/call-tool"
      ) {
        if (!mcpManager) {
          json(res, 503, {
            ok: false,
            error: {
              code: "MCP_CLIENT_UNAVAILABLE",
              message:
                "BrowserCrew Bridge MCP client is not enabled"
            }
          });
          return;
        }

        try {
          const body = await readJson(req);
          if (
            typeof body.server_id !== "string" ||
            !body.server_id.trim()
          ) {
            throw new Error("server_id is required");
          }
          if (
            typeof body.tool !== "string" ||
            !body.tool.trim()
          ) {
            throw new Error("tool is required");
          }
          if (
            body.arguments !== undefined &&
            (!body.arguments ||
              typeof body.arguments !== "object" ||
              Array.isArray(body.arguments))
          ) {
            throw new Error("arguments must be an object");
          }

          json(res, 200, {
            ok: true,
            data: await mcpManager.callTool(
              body.server_id.trim(),
              body.tool.trim(),
              body.arguments || {}
            )
          });
        } catch (error) {
          json(res, 502, {
            ok: false,
            error: {
              code: "MCP_CLIENT_FAILED",
              message:
                error instanceof Error
                  ? error.message
                  : String(error)
            }
          });
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/command") {
        if (!authorized(req, token)) {
          json(res, 401, {
            ok: false,
            error: {
              code: "UNAUTHORIZED",
              message: "Invalid BrowserCrew Bridge token"
            }
          });
          return;
        }

        if (!extension || extension.readyState !== WebSocket.OPEN) {
          json(res, 503, {
            ok: false,
            error: {
              code: "EXTENSION_NOT_CONNECTED",
              message: "BrowserCrew extension is not connected"
            }
          });
          return;
        }

        const command = normalizeCommand(await readJson(req));
        const id = crypto.randomUUID();

        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error("Bridge command timed out"));
          }, commandTimeoutMs);

          pending.set(id, { resolve, reject, timer });
          extension.send(
            JSON.stringify({
              type: "command",
              id,
              protocol_version: BRIDGE_PROTOCOL_VERSION,
              ...command
            })
          );
        });

        json(res, 200, result);
        return;
      }

      json(res, 404, {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: "Unknown BrowserCrew Bridge endpoint"
        }
      });
    } catch (error) {
      json(res, 400, {
        ok: false,
        error: {
          code: "BAD_REQUEST",
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", `http://${host}`);
    if (
      url.pathname !== "/ws" ||
      url.searchParams.get("token") !== token
    ) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString());

        if (message.type === "hello") {
          if (
            message.protocol_version !== BRIDGE_PROTOCOL_VERSION
          ) {
            ws.send(
              JSON.stringify({
                type: "hello_error",
                error: {
                  code: "PROTOCOL_MISMATCH",
                  message: `Expected protocol ${BRIDGE_PROTOCOL_VERSION}`
                }
              })
            );
            ws.close();
            return;
          }

          if (extension && extension !== ws) {
            extension.close();
          }

          extension = ws;
          extensionMeta = {
            extension_id: String(message.extension_id || ""),
            extension_version: String(message.extension_version || "")
          };
          ws.send(
            JSON.stringify({
              type: "hello_ack",
              protocol_version: BRIDGE_PROTOCOL_VERSION
            })
          );
          return;
        }

        if (message.type === "heartbeat") {
          ws.send(JSON.stringify({ type: "heartbeat_ack" }));
          return;
        }

        if (message.type === "result" && typeof message.id === "string") {
          const entry = pending.get(message.id);
          if (!entry) return;
          clearTimeout(entry.timer);
          pending.delete(message.id);
          entry.resolve({
            ok: Boolean(message.ok),
            ...(message.ok
              ? { data: message.data }
              : { error: message.error })
          });
        }
      } catch {
        // Ignore malformed extension messages; connection remains alive.
      }
    });

    ws.on("close", () => {
      if (extension === ws) {
        extension = null;
        extensionMeta = null;
      }
    });
  });

  return {
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      return server.address();
    },
    async close() {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("Bridge server stopped"));
      }
      pending.clear();
      extension?.close();
      await mcpManager?.closeAll?.().catch(
        () => undefined
      );
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
    server
  };
}
