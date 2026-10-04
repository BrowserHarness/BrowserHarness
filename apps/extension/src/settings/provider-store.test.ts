import { beforeEach, describe, expect, it } from "vitest";
import {
  createConnection,
  loadActiveConnection,
  loadConnections,
  loadEmbeddingConnection,
  removeConnection,
  saveConnection,
  saveRoutingConfig
} from "./provider-store";

let store: Record<string, unknown>;

beforeEach(() => {
  store = {};
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          get: async (keys: string | string[]) => {
            const list = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(
              list.map((key) => [key, store[key]])
            );
          },
          set: async (value: Record<string, unknown>) => {
            Object.assign(store, structuredClone(value));
          }
        }
      }
    }
  });
});

describe("provider connection routing", () => {
  it("migrates saved connections missing embedding health", async () => {
    store["browserharness.providerConnections"] = [
      {
        ...createConnection({
          provider: "openai-compatible",
          apiKey: "x",
          model: "text-embedding-test",
          baseUrl: "http://127.0.0.1:1234/v1"
        }),
        embeddingHealth: undefined
      }
    ];

    const [loaded] = await loadConnections();
    expect(loaded.embeddingHealth).toEqual({
      status: "unknown"
    });
  });

  it("never selects an embedding-only connection as the active chat model", async () => {
    const embedding = createConnection(
      {
        provider: "openai-compatible",
        apiKey: "x",
        model: "text-embedding-test",
        baseUrl: "http://127.0.0.1:1234/v1"
      },
      {
        embeddingHealth: { status: "healthy" }
      }
    );
    await saveConnection(embedding);
    await saveRoutingConfig({
      primaryConnectionId: embedding.id,
      embeddingConnectionId: embedding.id
    });

    expect(await loadActiveConnection()).toBeNull();
    expect((await loadEmbeddingConnection())?.id).toBe(
      embedding.id
    );
  });

  it("uses a dedicated healthy embedding route", async () => {
    const chat = createConnection(
      {
        provider: "openai",
        apiKey: "chat",
        model: "gpt-test"
      },
      {
        chatHealth: { status: "healthy" },
        agentHealth: { status: "healthy" }
      }
    );
    const embedding = createConnection(
      {
        provider: "openai-compatible",
        apiKey: "embed",
        model: "bge-small-en",
        baseUrl: "http://127.0.0.1:1234/v1"
      },
      {
        embeddingHealth: { status: "healthy" }
      }
    );

    await saveConnection(chat);
    await saveConnection(embedding);
    await saveRoutingConfig({
      primaryConnectionId: chat.id,
      embeddingConnectionId: embedding.id
    });

    expect((await loadActiveConnection())?.id).toBe(chat.id);
    expect((await loadEmbeddingConnection())?.id).toBe(
      embedding.id
    );
  });

  it("clears embedding routing when that connection is removed", async () => {
    const embedding = createConnection(
      {
        provider: "openai-compatible",
        apiKey: "embed",
        model: "text-embedding-test",
        baseUrl: "http://127.0.0.1:1234/v1"
      },
      {
        embeddingHealth: { status: "healthy" }
      }
    );
    await saveConnection(embedding);
    await saveRoutingConfig({
      embeddingConnectionId: embedding.id
    });

    await removeConnection(embedding.id);

    expect(await loadEmbeddingConnection()).toBeNull();
  });
});
