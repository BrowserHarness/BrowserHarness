import { afterEach, describe, expect, it, vi } from "vitest";
import {
  flattenMessages,
  setSubscriptionTransport,
  subscriptionComplete
} from "./subscription-client";
import {
  directChatCompletion,
  embedTexts,
  nextAgentDecision
} from "./model-client";
import {
  createConnection,
  hasCredentials,
  isSubscriptionProvider,
  subscriptionAdapterFor,
  type ProviderConfig
} from "../settings/provider-store";
import type { PageObservation } from "./protocol";

const claude: ProviderConfig = {
  provider: "claude-subscription",
  apiKey: "",
  model: "sonnet"
};

const observation: PageObservation = {
  tab_id: 1,
  url: "https://example.com/",
  title: "Example",
  visible_text: "A button named Continue is available.",
  elements: [
    {
      element_id: "bc-1",
      tag: "button",
      role: "button",
      accessible_name: "Continue",
      visible: true,
      disabled: false
    }
  ]
};

afterEach(() => {
  setSubscriptionTransport(null);
  vi.unstubAllGlobals();
});

describe("subscription providers", () => {
  it("map to a fixed Bridge adapter and need no API key", () => {
    expect(isSubscriptionProvider("claude-subscription")).toBe(true);
    expect(isSubscriptionProvider("openai")).toBe(false);
    expect(subscriptionAdapterFor("claude-subscription")).toBe("claude_cli");
    expect(subscriptionAdapterFor("chatgpt-subscription")).toBe("codex_cli");
    expect(hasCredentials(claude)).toBe(true);
    expect(hasCredentials({ provider: "openai", apiKey: "" })).toBe(false);
  });

  it("are text-only chat/agent connections", () => {
    const connection = createConnection({
      provider: "chatgpt-subscription",
      apiKey: "",
      model: "default"
    });
    expect(connection.capabilities.chat).toBe(true);
    expect(connection.capabilities.agent).toBe(true);
    expect(connection.capabilities.vision).toBe(false);
    expect(connection.label).toContain("ChatGPT subscription");
  });
});

describe("subscription transport", () => {
  it("flattens chat messages and ignores images", () => {
    expect(
      flattenMessages([
        { role: "system", content: "SYS" },
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
          ]
        }
      ])
    ).toEqual({ system: "SYS", prompt: "look" });
  });

  it("sends a fixed adapter id, model and a long enough timeout", async () => {
    const transport = vi.fn(async () => ({ ok: true, data: { text: " hi " } }));
    setSubscriptionTransport(transport);
    const text = await subscriptionComplete(
      claude,
      [{ role: "user", content: "yo" }],
      20_000
    );
    expect(text).toBe("hi");
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "BRIDGE_LLM",
        action: "complete",
        adapter: "claude_cli",
        model: "sonnet",
        prompt: "yo",
        timeout_ms: 90_000
      })
    );
  });

  it("surfaces Bridge errors in plain words", async () => {
    setSubscriptionTransport(async () => ({
      ok: false,
      error: { code: "ADAPTER_NOT_INSTALLED", message: "claude is not installed or not on PATH" }
    }));
    await expect(
      subscriptionComplete(claude, [{ role: "user", content: "x" }], 1000)
    ).rejects.toThrow("not installed");
  });

  it("honours cancellation", async () => {
    setSubscriptionTransport(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = subscriptionComplete(
      claude,
      [{ role: "user", content: "x" }],
      1000,
      controller.signal
    );
    controller.abort();
    await expect(pending).rejects.toThrow("Aborted");
  });
});

describe("model client over a subscription", () => {
  it("answers chat and agent turns without any network fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const seen: string[] = [];
    setSubscriptionTransport(async (request) => {
      seen.push(String(request.system));
      return {
        ok: true,
        data: {
          text: request.prompt?.includes("USER GOAL")
            ? '{"kind":"tool","tool":"click","input":{"element_id":"bc-1"},"note":"Clicking Continue"}'
            : "Hello!"
        }
      };
    });

    expect(await directChatCompletion(claude, "hi")).toBe("Hello!");

    const decision = await nextAgentDecision(
      claude,
      'Click the "Continue" button.',
      observation,
      []
    );
    expect(decision).toMatchObject({ kind: "tool", tool: "click" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses screenshots and embeddings", async () => {
    await expect(
      nextAgentDecision(claude, "t", observation, [], undefined, [], "data:image/png;base64,AAAA")
    ).rejects.toThrow("vision-capable");
    await expect(embedTexts(claude, ["a"])).rejects.toThrow("embeddings");
  });
});
