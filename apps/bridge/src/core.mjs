import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { createPairingManager, extensionIdFromOrigin } from "./pairing.mjs";

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

export const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];
export const REMOTE_MIN_TOKEN_LENGTH = 32;

export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.includes(host);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function authorized(req, token) {
  return safeEqual(req.headers.authorization || "", `Bearer ${token}`);
}

/**
 * Requests from web pages carry an http(s) Origin. Only the extension
 * (chrome-extension://) or local programs (no Origin) may talk to the Bridge,
 * which also stops DNS-rebinding pages from reaching it.
 */
function allowedOrigin(req) {
  const origin = req.headers.origin;
  return origin === undefined || Boolean(extensionIdFromOrigin(origin));
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
  mcpManager = null,
  llmManager = null,
  allowRemote = false,
  onExtensionEvent = null
} = {}) {
  if (!token) throw new Error("Bridge pairing token is required");
  if (!isLoopbackHost(host)) {
    if (allowRemote !== true) {
      throw new Error(
        "BrowserHarness Bridge must bind to loopback unless remote mode is explicitly enabled"
      );
    }
    if (String(token).length < REMOTE_MIN_TOKEN_LENGTH) {
      throw new Error(
        `Remote mode requires a pairing token of at least ${REMOTE_MIN_TOKEN_LENGTH} characters`
      );
    }
  }

  const startedAt = Date.now();
  let extension = null;
  let extensionMeta = null;
  const pending = new Map();
  const pairing = createPairingManager({ token });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://bridge.local");

      if (!allowedOrigin(req)) {
        json(res, 403, {
          ok: false,
          error: {
            code: "ORIGIN_NOT_ALLOWED",
            message: "BrowserHarness Bridge only accepts the BrowserHarness extension and local programs"
          }
        });
        return;
      }

      if (req.method === "POST" && url.pathname.startsWith("/pair/")) {
        const extensionId = extensionIdFromOrigin(req.headers.origin);
        const fromExtension = Boolean(extensionId);
        const body = await readJson(req, 16 * 1024);

        if (url.pathname === "/pair/request" || url.pathname === "/pair/status") {
          if (!fromExtension) {
            json(res, 403, {
              ok: false,
              error: {
                code: "EXTENSION_ORIGIN_REQUIRED",
                message: "Only the BrowserHarness extension can ask to pair"
              }
            });
            return;
          }
          json(
            res,
            200,
            url.pathname === "/pair/request"
              ? { ok: true, data: pairing.request({ extensionId }) }
              : {
                  ok: true,
                  data: pairing.poll(String(body.request_id || ""), extensionId)
                }
          );
          return;
        }

        // Approving needs the token, so only someone at this computer's
        // terminal (who can read the Bridge config) can approve.
        if (fromExtension || !authorized(req, token)) {
          json(res, 401, {
            ok: false,
            error: {
              code: "UNAUTHORIZED",
              message: "Invalid BrowserHarness Bridge token"
            }
          });
          return;
        }
        if (url.pathname === "/pair/pending") {
          json(res, 200, { ok: true, data: { requests: pairing.pending() } });
          return;
        }
        if (url.pathname === "/pair/approve") {
          const approved = pairing.approve(body.code);
          json(
            res,
            approved ? 200 : 404,
            approved
              ? { ok: true, data: approved }
              : {
                  ok: false,
                  error: {
                    code: "PAIRING_CODE_NOT_FOUND",
                    message: "No pairing request shows that code. Press Pair in BrowserHarness again."
                  }
                }
          );
          return;
        }
        if (url.pathname === "/pair/deny") {
          json(res, 200, { ok: pairing.deny(String(body.request_id || "")) });
          return;
        }
      }

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
          remote_mode: !isLoopbackHost(host),
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
            message: "Invalid BrowserHarness Bridge token"
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
                "BrowserHarness Bridge MCP client is not enabled"
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
                "BrowserHarness Bridge MCP client is not enabled"
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
                "BrowserHarness Bridge MCP client is not enabled"
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
              message: "Invalid BrowserHarness Bridge token"
            }
          });
          return;
        }

        if (!extension || extension.readyState !== WebSocket.OPEN) {
          json(res, 503, {
            ok: false,
            error: {
              code: "EXTENSION_NOT_CONNECTED",
              message: "BrowserHarness extension is not connected"
            }
          });
          return;
        }

        const command = normalizeCommand(await readJson(req));
        json(res, 200, await sendCommand(command));
        return;
      }

      json(res, 404, {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: "Unknown BrowserHarness Bridge endpoint"
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

  /** Sends one command to the extension and waits for its result. */
  function sendCommand(command) {
    if (!extension || extension.readyState !== WebSocket.OPEN) {
      return Promise.resolve({
        ok: false,
        error: { code: "EXTENSION_NOT_CONNECTED", message: "BrowserHarness extension is not connected" }
      });
    }
    const id = crypto.randomUUID();
    const target = extension;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Bridge command timed out"));
      }, commandTimeoutMs);

      pending.set(id, { resolve, reject, timer });
      target.send(
        JSON.stringify({
          type: "command",
          id,
          protocol_version: BRIDGE_PROTOCOL_VERSION,
          ...command
        })
      );
    });
  }

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://bridge.local");
    if (
      url.pathname !== "/ws" ||
      !allowedOrigin(req) ||
      !safeEqual(url.searchParams.get("token") || "", token)
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
    ws.on("message", async (raw) => {
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

        if (
          message.type === "llm_request" &&
          typeof message.id === "string"
        ) {
          const reply = (body) =>
            ws.send(
              JSON.stringify({ type: "llm_result", id: message.id, ...body })
            );
          if (extension !== ws) {
            reply({
              ok: false,
              error: {
                code: "LLM_EXTENSION_REQUIRED",
                message:
                  "Subscription requests must come from the paired BrowserHarness extension"
              }
            });
            return;
          }
          if (!llmManager) {
            reply({
              ok: false,
              error: {
                code: "LLM_ADAPTERS_UNAVAILABLE",
                message: "BrowserHarness Bridge subscription adapters are not enabled"
              }
            });
            return;
          }
          try {
            const args =
              message.args &&
              typeof message.args === "object" &&
              !Array.isArray(message.args)
                ? message.args
                : {};
            let data;
            if (message.action === "status") {
              data = await llmManager.status(String(args.adapter || ""));
            } else if (message.action === "complete") {
              data = await llmManager.complete({
                adapter: String(args.adapter || ""),
                model: args.model === undefined ? "default" : args.model,
                system: typeof args.system === "string" ? args.system : "",
                prompt: args.prompt,
                timeoutMs: Number(args.timeout_ms) || undefined
              });
            } else {
              throw Object.assign(
                new Error(
                  `Unsupported LLM request action: ${String(message.action || "")}`
                ),
                { code: "LLM_BAD_REQUEST" }
              );
            }
            reply({ ok: true, data });
          } catch (error) {
            reply({
              ok: false,
              error: {
                code:
                  typeof error?.code === "string" ? error.code : "LLM_FAILED",
                message: error instanceof Error ? error.message : String(error)
              }
            });
          }
          return;
        }

        if (
          message.type === "mcp_request" &&
          typeof message.id === "string"
        ) {
          if (extension !== ws) {
            ws.send(
              JSON.stringify({
                type: "mcp_result",
                id: message.id,
                ok: false,
                error: {
                  code: "MCP_EXTENSION_REQUIRED",
                  message:
                    "Outbound MCP requests must come from the paired BrowserHarness extension"
                }
              })
            );
            return;
          }

          if (!mcpManager) {
            ws.send(
              JSON.stringify({
                type: "mcp_result",
                id: message.id,
                ok: false,
                error: {
                  code: "MCP_CLIENT_UNAVAILABLE",
                  message:
                    "BrowserHarness Bridge MCP client is not enabled"
                }
              })
            );
            return;
          }

          try {
            let data;
            const args =
              message.args &&
              typeof message.args === "object" &&
              !Array.isArray(message.args)
                ? message.args
                : {};

            if (message.action === "servers") {
              data = {
                servers: await mcpManager.listServers()
              };
            } else if (message.action === "list_tools") {
              if (
                typeof args.server_id !== "string" ||
                !args.server_id.trim()
              ) {
                throw new Error("server_id is required");
              }
              data = await mcpManager.listTools(
                args.server_id.trim()
              );
            } else if (message.action === "call_tool") {
              if (
                typeof args.server_id !== "string" ||
                !args.server_id.trim()
              ) {
                throw new Error("server_id is required");
              }
              if (
                typeof args.tool !== "string" ||
                !args.tool.trim()
              ) {
                throw new Error("tool is required");
              }
              if (
                args.arguments !== undefined &&
                (!args.arguments ||
                  typeof args.arguments !== "object" ||
                  Array.isArray(args.arguments))
              ) {
                throw new Error(
                  "arguments must be an object"
                );
              }

              data = await mcpManager.callTool(
                args.server_id.trim(),
                args.tool.trim(),
                args.arguments || {},
                {
                  allowMutating:
                    message.approved === true
                }
              );
            } else {
              throw new Error(
                `Unsupported MCP request action: ${String(message.action || "")}`
              );
            }

            ws.send(
              JSON.stringify({
                type: "mcp_result",
                id: message.id,
                ok: true,
                data
              })
            );
          } catch (error) {
            const messageText =
              error instanceof Error
                ? error.message
                : String(error);
            ws.send(
              JSON.stringify({
                type: "mcp_result",
                id: message.id,
                ok: false,
                error: {
                  code: messageText.startsWith(
                    "MCP_APPROVAL_REQUIRED"
                  )
                    ? "APPROVAL_REQUIRED"
                    : "MCP_CLIENT_FAILED",
                  message: messageText
                }
              })
            );
          }
          return;
        }

        if (message.type === "remote_task_result" && typeof message.id === "string") {
          if (ws === extension) await onExtensionEvent?.(message);
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
              : { error: message.error }),
            // The page as it looks after the action, when the extension sent it.
            ...(message.ok && message.page ? { page: message.page } : {})
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
    sendCommand,
    server
  };
}
