import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createConnection,
  hasCredentials,
  hasEditableBaseUrl,
  isLocalProvider,
  providerBaseUrl,
  type ProviderConfig
} from "../settings/provider-store";
import { discoverModels } from "../settings/model-catalog";
import { checkSubscriptionReady, setSubscriptionTransport } from "./subscription-client";
import { directChatCompletion, testChatCapability } from "./model-client";

const lm: ProviderConfig = { provider: "lm-studio", apiKey: "", model: "qwen2.5-7b-instruct" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setSubscriptionTransport(null);
});

describe("local model providers", () => {
  it("default to the usual local ports and need no key", () => {
    expect(providerBaseUrl("lm-studio")).toBe("http://127.0.0.1:1234/v1");
    expect(providerBaseUrl("ollama")).toBe("http://127.0.0.1:11434/v1");
    expect(providerBaseUrl("lm-studio", "http://localhost:5000/v1/")).toBe("http://localhost:5000/v1");
    expect(isLocalProvider("ollama")).toBe(true);
    expect(hasEditableBaseUrl("lm-studio")).toBe(true);
    expect(hasEditableBaseUrl("openai")).toBe(false);
    expect(hasCredentials(lm)).toBe(true);
    expect(createConnection(lm).label).toContain("LM Studio");
  });

  it("discovers models without an Authorization header", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "qwen2.5-7b-instruct" }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchSpy);
    const models = await discoverModels({ provider: "lm-studio", apiKey: "" });
    expect(models.map((m) => m.id)).toEqual(["qwen2.5-7b-instruct"]);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:1234/v1/models");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("still requires a key for hosted providers", async () => {
    await expect(discoverModels({ provider: "openai", apiKey: "" })).rejects.toThrow("API key");
  });

  it("chats without sending an empty bearer token", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchSpy);
    expect(await directChatCompletion(lm, "hi")).toBe("OK");
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:1234/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("waits up to two minutes for a slow local model", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          })
      )
    );
    const pending = testChatCapability(lm).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(60_000);
    // Still waiting after a minute (hosted models would have given up at 30 s).
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await pending).toContain("timed out after 120 seconds");
  });

  it("explains a timeout in plain words", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          })
      )
    );
    const pending = testChatCapability({ provider: "openai", apiKey: "k", model: "gpt-x" }).catch(
      (error: Error) => error.message
    );
    await vi.advanceTimersByTimeAsync(31_000);
    const message = await pending;
    expect(message).toContain("timed out after 30 seconds");
    expect(message).toContain("try again");
  });
});

describe("subscription readiness", () => {
  it("reports the three real states", async () => {
    setSubscriptionTransport(async () => ({
      ok: false,
      error: { code: "BRIDGE_DISCONNECTED", message: "x" }
    }));
    expect((await checkSubscriptionReady("claude-subscription")).state).toBe("bridge_offline");

    setSubscriptionTransport(async () => ({ ok: true, data: { installed: false } }));
    const missing = await checkSubscriptionReady("chatgpt-subscription");
    expect(missing.state).toBe("cli_missing");
    expect(missing.message).toContain("Codex");

    setSubscriptionTransport(async () => ({ ok: true, data: { installed: true, version: "2.1.289" } }));
    const ready = await checkSubscriptionReady("claude-subscription");
    expect(ready).toEqual({ state: "ready", message: "Claude Code found (2.1.289)." });
  });
});
