// A question about the past in other words still finds the old fact, by
// meaning, when an embedding model is set up. One bounded call, inside the Space.
import { beforeEach, describe, expect, it, vi } from "vitest";

const embedCalls: string[][] = [];

vi.mock("../../settings/provider-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../settings/provider-store")>()),
  loadEmbeddingConnection: vi.fn(async () => ({ id: "e1", provider: "openai-compatible", model: "embed", apiKey: "x", baseUrl: "http://127.0.0.1:1/v1" }))
}));

vi.mock("../model-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../model-client")>()),
  // Toy meaning: anything about Pune or "stay" points the same way.
  embedTexts: vi.fn(async (_connection: unknown, inputs: string[]) => {
    embedCalls.push(inputs);
    return { dimensions: 2, vectors: inputs.map((text) => (/pune|stay/i.test(text) ? [1, 0] : [0, 1])) };
  })
}));

import { addFacts } from "../about-me";
import { createSpace, DEFAULT_SPACE_ID, pinSpace } from "../spaces";
import { compileContext } from ".";

let local: Record<string, unknown>;

beforeEach(() => {
  local = {};
  embedCalls.length = 0;
  pinSpace(null);
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          get: async (key: string | string[]) => {
            const keys = Array.isArray(key) ? key : [key];
            return Object.fromEntries(keys.map((name) => [name, structuredClone(local[name])]));
          },
          set: async (value: Record<string, unknown>) => Object.assign(local, structuredClone(value)),
          remove: async () => undefined
        }
      }
    }
  });
});

describe("history by meaning", () => {
  it("finds the old home for a question that shares no words with it", async () => {
    await addFacts(["I live in Pune"], "you", undefined, "global");
    await addFacts(["I live in Mumbai"], "you", undefined, "global");
    const compiled = await compileContext({ request: "Where did I stay earlier?", spaceId: DEFAULT_SPACE_ID, intent: "chat", recall: false });
    expect(compiled.sections.earlier?.map((item) => item.text)).toEqual([expect.stringMatching(/^I live in Pune \(until /)]);
    expect(compiled.sections.earlier?.[0].reason).toBe("the past question matches it by meaning");
    // One call, with only the question and this Space's (and every Space's) older facts.
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]).toEqual(["Where did I stay earlier?", "I live in Pune"]);
  });

  it("never compares another Space's old facts, and makes no call for an ordinary request", async () => {
    const work = await createSpace("Work", { switchTo: false });
    if (!work.ok) throw new Error("space");
    await addFacts(["I live in Pune"], "you", work.space.id);
    await addFacts(["I live in Mumbai"], "you", work.space.id);
    const compiled = await compileContext({ request: "Where did I stay earlier?", spaceId: DEFAULT_SPACE_ID, intent: "chat", recall: false });
    expect(compiled.sections.earlier).toBeUndefined();
    expect(embedCalls).toEqual([]);
    await compileContext({ request: "find a dentist", spaceId: work.space.id, intent: "chat", recall: false });
    expect(embedCalls).toEqual([]);
  });
});
