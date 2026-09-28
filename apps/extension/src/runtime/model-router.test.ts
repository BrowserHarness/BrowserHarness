import { afterEach, describe, expect, it, vi } from "vitest";
import {
  directChatWithFallback,
  isRecoverableProviderError
} from "./model-router";
import type { ProviderConnection } from "../settings/provider-store";

afterEach(() => {
  vi.restoreAllMocks();
});

function connection(
  id: string,
  provider: ProviderConnection["provider"],
  model: string,
  baseUrl: string
): ProviderConnection {
  return {
    id,
    provider,
    model,
    apiKey: "test-key",
    baseUrl,
    label: id,
    capabilities: {
      chat: true,
      agent: true,
      vision: false,
      embedding: false,
      reranker: false,
      audio: false,
      image: false,
      unknown: false
    },
    chatHealth: { status: "healthy" },
    agentHealth: { status: "healthy" },
    embeddingHealth: { status: "unknown" }
  };
}

describe("model fallback routing", () => {
  it("recognizes recoverable failures", () => {
    expect(isRecoverableProviderError(new Error("Model request failed (429)"))).toBe(true);
    expect(isRecoverableProviderError(new Error("Model request timed out after 20 seconds"))).toBe(true);
    expect(isRecoverableProviderError(new Error("Model request failed (503)"))).toBe(true);
  });

  it("does not hide authentication failures", () => {
    expect(isRecoverableProviderError(new Error("Model request failed (401)"))).toBe(false);
  });

  it("uses one fallback after a primary 429", async () => {
    const primary = connection(
      "primary",
      "openai-compatible",
      "primary-model",
      "https://primary.example/v1"
    );
    const fallback = connection(
      "fallback",
      "openai-compatible",
      "fallback-model",
      "https://fallback.example/v1"
    );

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("rate limit", { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "fallback answer" } }]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

    const result = await directChatWithFallback(
      primary,
      fallback,
      "hello"
    );

    expect(result.usedFallback).toBe(true);
    expect(result.connectionId).toBe("fallback");
    expect(result.result).toBe("fallback answer");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not fallback on 401", async () => {
    const primary = connection(
      "primary",
      "openai-compatible",
      "primary-model",
      "https://primary.example/v1"
    );
    const fallback = connection(
      "fallback",
      "openai-compatible",
      "fallback-model",
      "https://fallback.example/v1"
    );

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("unauthorized", { status: 401 })
    );

    await expect(
      directChatWithFallback(primary, fallback, "hello")
    ).rejects.toThrow("401");
  });
});
