import { afterEach, describe, expect, it, vi } from "vitest";
import {
  directChatCompletion,
  nextAgentDecision,
  parseAgentDecision,
  testModelConnection
} from "./model-client";
import type { PageObservation } from "./protocol";
import type { ProviderConfig } from "../settings/provider-store";
import type { TaskEpisodeMemory } from "./task-memory";

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
  it("requires both chat and structured agent capability", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "OK" } }]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    kind: "tool",
                    tool: "click",
                    input: { element_id: "bc-health-1" },
                    note: "Clicking Continue"
                  })
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

    const result = await testModelConnection(nvidia);
    expect(result.chat.ok).toBe(true);
    expect(result.chat.preview).toBe("OK");
    expect(result.agent.ok).toBe(true);
    expect(result.agent.preview).toContain("Structured browser action");
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

describe("episodic memory planning", () => {
  it("labels recalled task episodes as historical evidence", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  kind: "final",
                  message: "Done"
                })
              }
            }
          ]
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      )
    );

    const recalled: TaskEpisodeMemory = {
      schema_version: 1,
      id: "episode:checkout-prior",
      kind: "task_episode",
      recorded_at: "2026-09-28T08:00:00.000Z",
      session_id: "prior-session",
      title: "Prior checkout",
      task: "Finish checkout",
      status: "completed",
      start: {
        tab_id: 4,
        url: "https://example.com/checkout",
        title: "Checkout"
      },
      action_count: 1,
      manual_handoff_count: 0,
      tools: ["site_skill"],
      targets: ["Continue"],
      sites: ["https://example.com"],
      skill_refs: [
        {
          id: "SK-SITE-CHECKOUT",
          action: "run"
        }
      ],
      sensitive_payloads_removed: true
    };

    await nextAgentDecision(
      nvidia,
      "Finish checkout",
      observation,
      [],
      undefined,
      [],
      undefined,
      [recalled]
    );

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    const userPrompt = String(body.messages[1].content);

    expect(userPrompt).toContain(
      "RELEVANT PAST TASK EPISODES"
    );
    expect(userPrompt).toContain(
      "episode:checkout-prior"
    );
    expect(userPrompt).toContain(
      "historical evidence only"
    );
  });
});

describe("vision screenshot planning", () => {
  it("sends screenshot evidence as multimodal content for vision models", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  kind: "final",
                  message: "Visual page understood"
                })
              }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    await nextAgentDecision(
      {
        ...nvidia,
        model: "qwen/qwen2.5-vl-72b-instruct"
      },
      "Describe this page",
      observation,
      [],
      undefined,
      [],
      "data:image/png;base64,ZmFrZQ=="
    );

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.messages[1].content).toEqual([
      { type: "text", text: expect.any(String) },
      {
        type: "image_url",
        image_url: {
          url: "data:image/png;base64,ZmFrZQ=="
        }
      }
    ]);
  });

  it("rejects screenshot evidence for a non-vision model", async () => {
    await expect(
      nextAgentDecision(
        nvidia,
        "Describe this page",
        observation,
        [],
        undefined,
        [],
        "data:image/png;base64,ZmFrZQ=="
      )
    ).rejects.toThrow("vision-capable model");
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
