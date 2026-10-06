import {
  BRIDGE_SETTINGS_KEY,
  loadBridgeSettings,
  normalizeBridgeAddress,
  saveBridgeStatus,
  type BridgeSettings
} from "../settings/bridge-store";

export const BRIDGE_PROTOCOL_VERSION = "0.1";

export interface BridgeCommand {
  id: string;
  session: string;
  title: string;
  action: string;
  args: Record<string, unknown>;
}

export interface BridgeRpcResult {
  ok: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    details?: string;
  };
}

type BridgeCommandHandler = (
  command: BridgeCommand
) => Promise<BridgeRpcResult>;

interface PendingMcpRequest {
  resolve: (result: BridgeRpcResult) => void;
  timer: number;
}

let socket: WebSocket | null = null;
let heartbeatTimer: number | undefined;
let reconnectTimer: number | undefined;
let currentSettings: BridgeSettings | null = null;
let handler: BridgeCommandHandler | null = null;
const pendingMcp = new Map<string, PendingMcpRequest>();
const pendingLlm = new Map<string, PendingMcpRequest>();

function clearTimers() {
  if (heartbeatTimer !== undefined) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
  if (reconnectTimer !== undefined) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
}

function disconnect() {
  clearTimers();
  for (const pending of pendingMcp.values()) {
    clearTimeout(pending.timer);
    pending.resolve({
      ok: false,
      error: {
        code: "BRIDGE_DISCONNECTED",
        message:
          "BrowserHarness Bridge disconnected before the MCP request completed"
      }
    });
  }
  pendingMcp.clear();
  for (const pending of pendingLlm.values()) {
    clearTimeout(pending.timer);
    pending.resolve({
      ok: false,
      error: {
        code: "BRIDGE_DISCONNECTED",
        message:
          "BrowserHarness Bridge disconnected before the subscription request completed"
      }
    });
  }
  pendingLlm.clear();

  if (socket) {
    const existing = socket;
    socket = null;
    existing.close();
  }
}

function websocketUrl(settings: BridgeSettings): string {
  const normalized = new URL(normalizeBridgeAddress(settings.address));
  normalized.searchParams.set("token", settings.token);
  return normalized.toString();
}

function scheduleReconnect() {
  if (!currentSettings?.enabled || !currentSettings.token || reconnectTimer !== undefined) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void connectCurrent();
  }, 2_000) as unknown as number;
}

async function handleMessage(raw: MessageEvent) {
  if (!socket || !handler) return;

  let message: unknown;
  try {
    message = JSON.parse(String(raw.data));
  } catch {
    return;
  }

  if (!message || typeof message !== "object") return;
  const value = message as Record<string, unknown>;

  if (
    value.type === "mcp_result" &&
    typeof value.id === "string"
  ) {
    const pending = pendingMcp.get(value.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingMcp.delete(value.id);
    pending.resolve({
      ok: value.ok === true,
      ...(value.ok === true
        ? { data: value.data }
        : {
            error: {
              code:
                typeof (value.error as { code?: unknown } | undefined)
                  ?.code === "string"
                  ? String(
                      (value.error as { code: string }).code
                    )
                  : "MCP_CLIENT_FAILED",
              message:
                typeof (value.error as { message?: unknown } | undefined)
                  ?.message === "string"
                  ? String(
                      (value.error as { message: string }).message
                    )
                  : "Outbound MCP request failed"
            }
          })
    });
    return;
  }

  if (
    value.type === "llm_result" &&
    typeof value.id === "string"
  ) {
    const pending = pendingLlm.get(value.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingLlm.delete(value.id);
    const errorValue = value.error as
      | { code?: unknown; message?: unknown }
      | undefined;
    pending.resolve(
      value.ok === true
        ? { ok: true, data: value.data }
        : {
            ok: false,
            error: {
              code:
                typeof errorValue?.code === "string"
                  ? errorValue.code
                  : "LLM_FAILED",
              message:
                typeof errorValue?.message === "string"
                  ? errorValue.message
                  : "Subscription request failed"
            }
          }
    );
    return;
  }

  if (value.type === "hello_ack") {
    await saveBridgeStatus({
      state: "connected",
      message: "Local agent bridge connected",
      chat_apps: Array.isArray(value.chat_apps) ? value.chat_apps.filter((app): app is string => typeof app === "string") : []
    });
    return;
  }

  if (value.type === "hello_error") {
    await saveBridgeStatus({
      state: "error",
      message:
        typeof (value.error as { message?: unknown } | undefined)?.message === "string"
          ? String((value.error as { message: string }).message)
          : "Bridge protocol handshake failed"
    });
    socket.close();
    return;
  }

  if (
    value.type !== "command" ||
    typeof value.id !== "string" ||
    typeof value.session !== "string" ||
    typeof value.action !== "string" ||
    value.protocol_version !== BRIDGE_PROTOCOL_VERSION
  ) {
    return;
  }

  const args =
    value.args &&
    typeof value.args === "object" &&
    !Array.isArray(value.args)
      ? (value.args as Record<string, unknown>)
      : {};

  try {
    const result = await handler({
      id: value.id,
      session: value.session,
      title:
        typeof value.title === "string" && value.title.trim()
          ? value.title
          : value.session,
      action: value.action,
      args
    });
    socket?.send(
      JSON.stringify({
        type: "result",
        id: value.id,
        ...result
      })
    );
  } catch (error) {
    socket?.send(
      JSON.stringify({
        type: "result",
        id: value.id,
        ok: false,
        error: {
          code: "BRIDGE_COMMAND_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Bridge command failed"
        }
      })
    );
  }
}

async function connectCurrent() {
  disconnect();
  currentSettings = await loadBridgeSettings();

  if (!currentSettings.enabled) {
    await saveBridgeStatus({ state: "disabled" });
    return;
  }

  if (!currentSettings.token.trim()) {
    await saveBridgeStatus({
      state: "error",
      message: "Bridge pairing token is required"
    });
    return;
  }

  let url: string;
  try {
    url = websocketUrl(currentSettings);
  } catch (error) {
    await saveBridgeStatus({
      state: "error",
      message:
        error instanceof Error
          ? error.message
          : "Invalid bridge address"
    });
    return;
  }

  await saveBridgeStatus({
    state: "connecting",
    message: "Connecting to local BrowserHarness Bridge"
  });

  const next = new WebSocket(url);
  socket = next;

  next.addEventListener("open", () => {
    if (socket !== next) return;
    next.send(
      JSON.stringify({
        type: "hello",
        protocol_version: BRIDGE_PROTOCOL_VERSION,
        extension_id: chrome.runtime.id,
        extension_version: chrome.runtime.getManifest().version
      })
    );

    heartbeatTimer = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: "heartbeat",
            at: Date.now()
          })
        );
      }
    }, 20_000) as unknown as number;
  });

  next.addEventListener("message", (event) => {
    void handleMessage(event);
  });

  next.addEventListener("close", () => {
    if (socket === next) socket = null;
    clearTimers();
    void saveBridgeStatus({
      state: "disconnected",
      message: "Local BrowserHarness Bridge disconnected"
    });
    scheduleReconnect();
  });

  next.addEventListener("error", () => {
    void saveBridgeStatus({
      state: "error",
      message: "Could not connect to local BrowserHarness Bridge"
    });
  });
}

export async function requestBridgeMcp(
  action: "servers" | "list_tools" | "call_tool",
  args: Record<string, unknown> = {},
  approved = false
): Promise<BridgeRpcResult> {
  if (
    !socket ||
    socket.readyState !== WebSocket.OPEN ||
    !currentSettings?.enabled
  ) {
    return {
      ok: false,
      error: {
        code: "BRIDGE_DISCONNECTED",
        message:
          "Connect BrowserHarness Bridge before using external MCP tools"
      }
    };
  }

  const id = crypto.randomUUID();

  return new Promise<BridgeRpcResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingMcp.delete(id);
      resolve({
        ok: false,
        error: {
          code: "MCP_REQUEST_TIMEOUT",
          message:
            "Outbound MCP request timed out"
        }
      });
    }, 40_000) as unknown as number;

    pendingMcp.set(id, { resolve, timer });

    try {
      socket?.send(
        JSON.stringify({
          type: "mcp_request",
          id,
          action,
          args,
          approved
        })
      );
    } catch (error) {
      clearTimeout(timer);
      pendingMcp.delete(id);
      resolve({
        ok: false,
        error: {
          code: "BRIDGE_DISCONNECTED",
          message:
            error instanceof Error
              ? error.message
              : "Could not send outbound MCP request"
        }
      });
    }
  });
}

/**
 * Ask the Bridge to run a prompt through the user's own ChatGPT or Claude
 * subscription via the vendor's official CLI. The extension names an adapter
 * and a model only; the Bridge owns the command line.
 */
export async function requestBridgeLlm(
  action: "status" | "complete",
  args: Record<string, unknown>,
  timeoutMs = 150_000
): Promise<BridgeRpcResult> {
  if (
    !socket ||
    socket.readyState !== WebSocket.OPEN ||
    !currentSettings?.enabled
  ) {
    return {
      ok: false,
      error: {
        code: "BRIDGE_DISCONNECTED",
        message:
          "Connect the helper app (Settings → Helper app) before using a ChatGPT or Claude subscription"
      }
    };
  }

  const id = crypto.randomUUID();

  return new Promise<BridgeRpcResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingLlm.delete(id);
      resolve({
        ok: false,
        error: {
          code: "LLM_REQUEST_TIMEOUT",
          message: "The subscription request timed out"
        }
      });
    }, timeoutMs) as unknown as number;

    pendingLlm.set(id, { resolve, timer });

    try {
      socket?.send(
        JSON.stringify({ type: "llm_request", id, action, args })
      );
    } catch (error) {
      clearTimeout(timer);
      pendingLlm.delete(id);
      resolve({
        ok: false,
        error: {
          code: "BRIDGE_DISCONNECTED",
          message:
            error instanceof Error
              ? error.message
              : "Could not send the subscription request"
        }
      });
    }
  });
}

/** Sends an event to the Bridge; false when it is not connected. */
export function sendBridgeEvent(message: Record<string, unknown>): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

export function startBridgeClient(
  commandHandler: BridgeCommandHandler
): void {
  handler = commandHandler;
  void connectCurrent();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (
      areaName === "local" &&
      changes[BRIDGE_SETTINGS_KEY]
    ) {
      void connectCurrent();
    }
  });
}
