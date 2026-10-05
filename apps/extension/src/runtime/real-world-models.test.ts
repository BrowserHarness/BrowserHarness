import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentSystemFor,
  directChatCompletion,
  nextAgentDecision,
  parseAgentDecision
} from "./model-client";
import { renderObservationForPrompt, LOCAL_BUDGET } from "./prompt-budget";
import { hasCredentials, type ProviderConfig } from "../settings/provider-store";
import type { PageObservation } from "./protocol";

afterEach(() => {
  vi.restoreAllMocks();
});

const lmStudio: ProviderConfig = {
  provider: "lm-studio",
  apiKey: "",
  model: "qwen/qwen3-8b",
  baseUrl: "http://127.0.0.1:1234/v1"
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });

function busyPage(elements: number): PageObservation {
  return {
    tab_id: 7,
    url: "https://shop.example.com/search?q=shoes",
    title: "Shoes",
    visible_text: "result ".repeat(5000),
    elements: Array.from({ length: elements }, (_, index) => ({
      element_id: `@e${index + 1}`,
      tag: "a",
      role: "link",
      accessible_name: `Product ${index + 1} with a fairly long accessible name`,
      visible: true,
      disabled: false
    }))
  };
}

describe("small local models", () => {
  it("keep a busy page within a small context window", async () => {
    let sent = "";
    let system = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      system = body.messages[0].content;
      sent = body.messages[1].content;
      return json({
        choices: [{ message: { content: '{"kind":"final","message":"done"}' } }]
      });
    });
    const trail = Array.from(
      { length: 10 },
      (_, index) => `read_page: ${JSON.stringify({ ok: true, data: { text: "x".repeat(30_000), index } })}`
    );
    await nextAgentDecision(lmStudio, "find red shoes", busyPage(250), trail);
    // About 4 characters per token: system + prompt stay well under 4k tokens.
    expect((system.length + sent.length) / 4).toBeLessThan(3500);
    expect(sent).toContain("@e1 link");
    expect(sent).toContain("first 70 shown");
    expect(system).toBe(agentSystemFor(lmStudio));
  });

  it("ask LM Studio for a well-formed action with a JSON schema", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({ choices: [{ message: { content: '{"kind":"final","message":"ok"}' } }] })
    );
    await nextAgentDecision(lmStudio, "goal", busyPage(2), []);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.schema.required).toEqual(["kind"]);
  });

  it("retry without structured output when an older server rejects it", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ error: "response_format not supported" }, 400))
      .mockResolvedValueOnce(
        json({ choices: [{ message: { content: '{"kind":"final","message":"ok"}' } }] })
      );
    const decision = await nextAgentDecision(lmStudio, "goal", busyPage(2), []);
    expect(decision).toEqual({ kind: "final", message: "ok" });
    const retry = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(retry.response_format).toBeUndefined();
  });

  it("explain a context-window overflow in plain words", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({ error: "The number of tokens to keep from the initial prompt is greater than the context length" }, 400)
    );
    await expect(
      directChatCompletion({ ...lmStudio, provider: "openai-compatible" }, "hi")
    ).rejects.toThrow("too big for qwen/qwen3-8b's context window");
  });

  it("accept sloppy action JSON", () => {
    expect(parseAgentDecision('{"tool":"click","element_id":"e3"}')).toMatchObject({
      kind: "tool",
      tool: "click",
      input: { element_id: "@e3" }
    });
    expect(parseAgentDecision('{"kind":"tool","tool":"type","input":{"element_id":4,"text":"hi"}}')).toMatchObject({
      input: { element_id: "@e4", text: "hi" }
    });
    expect(parseAgentDecision('{"tool":"navigate","url":"amazon.com","note":"Go"}')).toMatchObject({
      input: { url: "amazon.com" },
      note: "Go"
    });
  });

  it("treat a key-less server on this computer as connected", () => {
    expect(
      hasCredentials({ provider: "openai-compatible", apiKey: "", baseUrl: "http://192.168.1.20:8080/v1" })
    ).toBe(true);
    expect(
      hasCredentials({ provider: "openai-compatible", apiKey: "", baseUrl: "https://api.example.com/v1" })
    ).toBe(false);
  });
});

describe("hosted models", () => {
  it("surface an error returned with HTTP 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({ error: { message: "Provider returned error: quota exceeded" } })
    );
    await expect(
      directChatCompletion({ provider: "openrouter", apiKey: "k", model: "x/y" }, "hi")
    ).rejects.toThrow("quota exceeded");
  });

  it("render the page once, as one line per element", () => {
    const text = renderObservationForPrompt(busyPage(3));
    expect(text.match(/@e1 /g)).toHaveLength(1);
    expect(text).not.toContain('"element_id"');
    expect(renderObservationForPrompt(busyPage(100), LOCAL_BUDGET)).toContain("first 70 shown");
  });
});
