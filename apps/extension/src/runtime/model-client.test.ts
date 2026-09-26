import { afterEach, describe, expect, it, vi } from "vitest";
import {
  directChatCompletion,
  nextAgentDecision,
  parseAgentDecision,
  testModelConnection
} from "./model-client";
import type { PageObservation } from "./protocol";
import type { ProviderConfig } from "../settings/provider-store";

afterEach(() => {
  vi.restoreAllMocks();
});

const nvidia: ProviderConfig = {
  provider: "nvidia",
  apiKey: "nvapi-test",
  model: "meta/test-chat",
  baseUrl: "https://integrate.api.nvidia.com/v1"
};

const observation: PageObservation = {
  tab_id: 1,
  url: "https://example.com",
  title: "Example",
  visible_text: "Pricing",
  elements: [
    {
      element_id: "bc-1",
      tag: "a",
      role: "link",
      accessible_name: "Pricing",
      visible: true,
      disabled: false
    }
  ]
};

describe("directChatCompletion", () => {
  it("uses plain chat output for NVIDIA direct chat", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Hello from NVIDIA" } }]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await directChatCompletion(nvidia, "hi");
    expect(result).toBe("Hello from NVIDIA");

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.response_format).toBeUndefined();
    expect(body.messages[1].content).toBe("hi");
  });

  it("falls back to plain NVIDIA chat on a structured-parameter 400", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("bad parameter", { status: 400 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "OK" } }]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

    const result = await directChatCompletion(
      {
        ...nvidia,
        model: "nvidia/nemotron-test"
      },
      "hello"
    );

    expect(result).toBe("OK");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, secondInit] = fetchMock.mock.calls[1];
    const secondBody = JSON.parse(String(secondInit?.body));
    expect(secondBody.chat_template_kwargs).toBeUndefined();
  });

  it("surfaces rate limit errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("rate limited", { status: 429 })
    );

    await expect(directChatCompletion(nvidia, "hello")).rejects.toThrow(
      "Model request failed (429)"
    );
  });
});

describe("testModelConnection", () => {
  it("accepts a small successful inference response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "OK" } }]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await testModelConnection(nvidia);
    expect(result.ok).toBe(true);
    expect(result.preview).toBe("OK");
  });
});

describe("nextAgentDecision", () => {
  it("uses structured output for NVIDIA browser planning", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  kind: "tool",
                  tool: "click",
                  input: { element_id: "bc-1" },
                  note: "Opening pricing"
                })
              }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const decision = await nextAgentDecision(
      nvidia,
      "open the pricing link",
      observation,
      []
    );

    expect(decision).toMatchObject({
      kind: "tool",
      tool: "click",
      input: { element_id: "bc-1" }
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.response_format).toEqual({ type: "json_object" });
  });
});

describe("parseAgentDecision", () => {
  it("extracts a balanced JSON object from surrounding text", () => {
    expect(
      parseAgentDecision(
        'extra text {"kind":"final","message":"done"} trailing text'
      )
    ).toEqual({ kind: "final", message: "done" });
  });
});
