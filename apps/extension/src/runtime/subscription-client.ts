import {
  subscriptionAdapterFor,
  type ProviderConfig
} from "../settings/provider-store";
import type { BridgeLlmRequest } from "./protocol";

export interface SubscriptionTransportResult {
  ok: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
}

export type SubscriptionTransport = (
  request: BridgeLlmRequest
) => Promise<SubscriptionTransportResult>;

// CLI start-up plus a model turn is much slower than an API call.
const MIN_SUBSCRIPTION_TIMEOUT_MS = 90_000;

const chromeTransport: SubscriptionTransport = (request) =>
  chrome.runtime.sendMessage(request);

let transport: SubscriptionTransport = chromeTransport;

/** Test seam: swap the extension-to-Bridge hop. */
export function setSubscriptionTransport(
  next: SubscriptionTransport | null
): void {
  transport = next ?? chromeTransport;
}

interface ChatMessage {
  role?: unknown;
  content?: unknown;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text"
          ? String((part as { text?: unknown }).text ?? "")
          : ""
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Flatten OpenAI-style chat messages into one system and one user prompt. */
export function flattenMessages(messages: unknown): {
  system: string;
  prompt: string;
} {
  const list = Array.isArray(messages) ? (messages as ChatMessage[]) : [];
  const system = list
    .filter((message) => message.role === "system")
    .map((message) => textOf(message.content))
    .join("\n\n");
  const prompt = list
    .filter((message) => message.role !== "system")
    .map((message) => textOf(message.content))
    .join("\n\n");
  return { system, prompt };
}

export async function subscriptionComplete(
  config: ProviderConfig,
  messages: unknown,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  const adapter = subscriptionAdapterFor(config.provider);
  if (!adapter) {
    throw new Error("This provider is not a subscription adapter.");
  }
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const { system, prompt } = flattenMessages(messages);
  const effectiveTimeout = Math.max(timeoutMs, MIN_SUBSCRIPTION_TIMEOUT_MS);

  const request = transport({
    type: "BRIDGE_LLM",
    action: "complete",
    adapter,
    model: config.model || "default",
    system,
    prompt,
    timeout_ms: effectiveTimeout
  });

  const aborted = new Promise<never>((_, reject) => {
    signal?.addEventListener(
      "abort",
      () => reject(new DOMException("Aborted", "AbortError")),
      { once: true }
    );
  });

  const result = await (signal ? Promise.race([request, aborted]) : request);

  if (!result?.ok) {
    throw new Error(
      result?.error?.message ||
        "The subscription request failed. Check that the helper app is running and paired (Settings → Helper app)."
    );
  }

  const text = String((result.data as { text?: unknown } | undefined)?.text ?? "").trim();
  if (!text) {
    throw new Error("The subscription returned an empty response.");
  }
  return text;
}

export type SubscriptionReadiness =
  | { state: "ready"; message: string }
  | { state: "bridge_offline"; message: string }
  | { state: "cli_missing"; message: string }
  | { state: "error"; message: string };

/** Is the Bridge connected and the vendor's app installed on this computer? */
export async function checkSubscriptionReady(
  provider: ProviderConfig["provider"]
): Promise<SubscriptionReadiness> {
  const adapter = subscriptionAdapterFor(provider);
  if (!adapter) {
    return { state: "error", message: "This provider is not a subscription adapter." };
  }
  const appName = adapter === "claude_cli" ? "Claude Code" : "Codex";

  let result: SubscriptionTransportResult;
  try {
    result = await transport({ type: "BRIDGE_LLM", action: "status", adapter });
  } catch (error) {
    return {
      state: "error",
      message: error instanceof Error ? error.message : "Could not reach the Bridge."
    };
  }

  if (!result?.ok) {
    return result?.error?.code === "BRIDGE_DISCONNECTED"
      ? {
          state: "bridge_offline",
          message:
            "The helper app is not connected. Start it on your computer and pair it under Settings → Helper app."
        }
      : {
          state: "error",
          message: result?.error?.message || "The Bridge could not check this subscription."
        };
  }

  const data = (result.data || {}) as { installed?: boolean; version?: string };
  return data.installed
    ? { state: "ready", message: `${appName} found${data.version ? ` (${data.version})` : ""}.` }
    : {
        state: "cli_missing",
        message: `${appName} was not found on the computer running the Bridge. Install it and sign in once, then check again.`
      };
}
