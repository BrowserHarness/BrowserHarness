import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  indexTaskEpisodeMemory,
  searchTaskMemoryHybrid,
  taskEpisodeEmbeddingText
} from "./semantic-memory";
import {
  saveTaskEpisodeMemory,
  type TaskEpisodeMemory
} from "./task-memory";
import * as providerStore from "../settings/provider-store";
import * as modelClient from "./model-client";
import type { BrowserTaskSessionEvidence } from "./session-evidence";

let localStore: Record<string, unknown>;

function session(
  id: string,
  task: string,
  url: string,
  target: string
): BrowserTaskSessionEvidence {
  return {
    version: 1,
    session_id: id,
    title: task,
    task,
    started_at: id.endsWith("2")
      ? "2026-09-28T10:00:02.000Z"
      : "2026-09-28T10:00:01.000Z",
    status: "completed",
    start: { tab_id: 1, url, title: task },
    actions: [
      {
        id: "action-1",
        ordinal: 1,
        recorded_at: "2026-09-28T10:00:03.000Z",
        tool: "click",
        input: {
          element_id: "@e1",
          text: "private-value"
        },
        note: "Continue",
        before: { tab_id: 1, url, title: task },
        target: {
          element_id: "@e1",
          tag: "button",
          role: "button",
          accessible_name: target
        },
        approval: {
          required: false,
          approved: true
        }
      }
    ],
    boundary_action_id: "action-1",
    tab_evidence: []
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStore = {};
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          get: async (key: string | string[]) => {
            const keys = Array.isArray(key) ? key : [key];
            return Object.fromEntries(
              keys.map((name) => [name, localStore[name]])
            );
          },
          set: async (value: Record<string, unknown>) => {
            Object.assign(localStore, structuredClone(value));
          }
        }
      }
    }
  });

  vi.spyOn(
    providerStore,
    "loadEmbeddingConnection"
  ).mockResolvedValue({
    id: "embed-1",
    label: "Local embeddings",
    provider: "openai-compatible",
    apiKey: "x",
    model: "bge-small-en",
    baseUrl: "http://127.0.0.1:1234/v1",
    capabilities: {
      chat: false,
      agent: false,
      vision: false,
      embedding: true,
      reranker: false,
      audio: false,
      image: false,
      unknown: false
    },
    chatHealth: { status: "unknown" },
    agentHealth: { status: "unknown" },
    embeddingHealth: { status: "healthy" }
  });
});

describe("semantic task memory", () => {
  it("indexes only sanitized episode text", async () => {
    const episode = await saveTaskEpisodeMemory(
      session(
        "session-1",
        "Finish checkout",
        "https://shop.example/checkout",
        "Place order"
      )
    );

    const embed = vi.spyOn(
      modelClient,
      "embedTexts"
    ).mockResolvedValue({
      vectors: [[1, 0, 0]],
      dimensions: 3
    });

    await indexTaskEpisodeMemory(episode);

    const text = String(embed.mock.calls[0][1][0]);
    expect(text).toContain("Finish checkout");
    expect(text).toContain("Place order");
    expect(text).not.toContain("private-value");
  });

  it("ranks semantic evidence and keeps retrieval metadata", async () => {
    const first = await saveTaskEpisodeMemory(
      session(
        "session-1",
        "Buy groceries",
        "https://grocer.example/cart",
        "Checkout"
      )
    );
    const second = await saveTaskEpisodeMemory(
      session(
        "session-2",
        "Reserve a table",
        "https://dining.example/book",
        "Reserve"
      )
    );

    vi.spyOn(modelClient, "embedTexts").mockImplementation(
      async (_config, inputs) => {
        if (
          inputs.length === 1 &&
          inputs[0] === "book dinner"
        ) {
          return {
            vectors: [[0, 1]],
            dimensions: 2
          };
        }

        return {
          vectors: inputs.map((text) =>
            text.includes("Reserve a table")
              ? [0, 1]
              : [1, 0]
          ),
          dimensions: 2
        };
      }
    );

    const hits = await searchTaskMemoryHybrid(
      "book dinner",
      2
    );

    expect(hits[0].episode.id).toBe(second.id);
    expect(hits[0].retrieval).toContain("semantic");
    expect(hits[0].semantic_rank).toBe(1);
    expect(
      hits.some((hit) => hit.episode.id === first.id)
    ).toBe(true);
  });

  it("falls back to lexical retrieval when the embedding endpoint fails", async () => {
    const episode = await saveTaskEpisodeMemory(
      session(
        "session-1",
        "Check account billing",
        "https://example.com/billing",
        "Billing"
      )
    );

    vi.spyOn(modelClient, "embedTexts").mockRejectedValue(
      new Error("Embedding request failed (503)")
    );

    const hits = await searchTaskMemoryHybrid(
      "billing",
      3
    );

    expect(hits[0]).toMatchObject({
      episode: { id: episode.id },
      retrieval: ["lexical"],
      lexical_rank: 1
    });
  });

  it("falls back to lexical retrieval without embeddings", async () => {
    vi.mocked(
      providerStore.loadEmbeddingConnection
    ).mockResolvedValue(null);

    const episode = await saveTaskEpisodeMemory(
      session(
        "session-1",
        "Check pricing",
        "https://example.com/pricing",
        "Pricing"
      )
    );

    const hits = await searchTaskMemoryHybrid(
      "pricing",
      3
    );

    expect(hits[0]).toMatchObject({
      episode: { id: episode.id },
      retrieval: ["lexical"],
      lexical_rank: 1
    });
  });

  it("builds embedding text only from episode fields", () => {
    const episode: TaskEpisodeMemory = {
      schema_version: 1,
      id: "episode-1",
      kind: "task_episode",
      recorded_at: "2026-09-28T10:00:00.000Z",
      session_id: "session-1",
      title: "Account",
      task: "Open account",
      status: "completed",
      start: {
        tab_id: 1,
        url: "https://example.com",
        title: "Example"
      },
      action_count: 1,
      manual_handoff_count: 0,
      tools: ["click"],
      targets: ["Account"],
      sites: ["https://example.com"],
      skill_refs: [],
      sensitive_payloads_removed: true
    };

    expect(taskEpisodeEmbeddingText(episode)).toContain(
      "Open account"
    );
  });
});
