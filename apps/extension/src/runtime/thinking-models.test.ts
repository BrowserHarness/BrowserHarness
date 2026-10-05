import { afterEach, describe, expect, it, vi } from "vitest";
import {
  directChatCompletion,
  stripThinking,
  tuneRequestBody
} from "./model-client";
import type { ProviderConfig } from "../settings/provider-store";

afterEach(() => {
  vi.restoreAllMocks();
});

const openrouter: ProviderConfig = {
  provider: "openrouter",
  apiKey: "sk-or-test",
  model: "openrouter/auto"
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });

describe("thinking models", () => {
  it("removes think blocks local models put in the answer", () => {
    expect(stripThinking("<think>plan it</think>\n\nThe script.")).toBe("The script.");
    expect(stripThinking("<think>still going")).toBe("");
    expect(stripThinking("No thinking here")).toBe("No thinking here");
  });

  it("asks OpenRouter to keep reasoning short and gives local models room", () => {
    expect(tuneRequestBody(openrouter, { max_tokens: 512 }).reasoning).toEqual({
      effort: "low",
      exclude: true
    });
    expect(
      tuneRequestBody(
        { provider: "lm-studio", apiKey: "", model: "qwen/qwen3-8b" },
        { max_tokens: 700 }
      ).max_tokens
    ).toBe(4096);
    expect(
      tuneRequestBody(
        { provider: "openai", apiKey: "k", model: "gpt-4.1" },
        { max_tokens: 700 }
      )
    ).toEqual({ max_tokens: 700 });
  });

  it("retries once with a bigger budget when the model only thought", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        json({
          choices: [
            { finish_reason: "length", message: { content: "", reasoning: "long thoughts" } }
          ]
        })
      )
      .mockResolvedValueOnce(
        json({ choices: [{ finish_reason: "stop", message: { content: "A 30 second script." } }] })
      );

    await expect(directChatCompletion(openrouter, "write a script")).resolves.toBe(
      "A 30 second script."
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(retryBody.max_tokens).toBeGreaterThanOrEqual(4096);
  });

  it("explains a reply that stays empty instead of blaming the model type", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      json({ choices: [{ finish_reason: "length", message: { content: "" } }] })
    );
    await expect(directChatCompletion(openrouter, "hi")).rejects.toThrow(
      "pick another model from the model menu"
    );
  });
});
