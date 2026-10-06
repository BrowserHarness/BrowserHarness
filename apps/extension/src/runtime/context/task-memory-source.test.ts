// Memory v2, Phase 5: one task reads one memory source. The context it is
// compiled with, the agent's own recall and every helper's recall all go to
// the same source, in the same Space, never to this device's store behind
// its back.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserEngineDependencies } from "../browser-engine";
import type { ReadOnlySubagentDependencies } from "../subagent-runner";

let parentDeps: BrowserEngineDependencies | null = null;
const helperDeps: ReadOnlySubagentDependencies[] = [];

vi.mock("../browser-engine", async (importOriginal) => {
  const original = await importOriginal<typeof import("../browser-engine")>();
  return {
    ...original,
    // Stands in for the browser run: recalls once as the parent, then starts two helpers.
    runBrowserTask: vi.fn(async (task: string, dependencies: BrowserEngineDependencies) => {
      parentDeps = dependencies;
      await dependencies.recallMemory?.(task, { url: "https://shop.example/kettles" } as never);
      await dependencies.tool("agent", { tasks: ["check kettle A", "check kettle B"] });
      const evidence = { version: 1, session_id: "s", title: task, task, started_at: "2026-10-06T12:00:00.000Z", status: "completed", start: { tab_id: 1, url: "https://shop.example", title: "Shop" }, actions: [], tab_evidence: [] };
      return { status: "completed", message: "done", session_evidence: evidence };
    })
  };
});

vi.mock("../subagent-runner", async (importOriginal) => {
  const original = await importOriginal<typeof import("../subagent-runner")>();
  return {
    ...original,
    runReadOnlySubagent: vi.fn(async (task: string, dependencies: ReadOnlySubagentDependencies) => {
      helperDeps.push(dependencies);
      await dependencies.recallMemory?.(task, { url: "https://shop.example/a" } as never);
      return { status: "completed", task, session_id: "w", summary: "ok", sources: [], evidence: [], steps: 1 };
    })
  };
});

import { runAgentTask } from "../agent-task";
import { compileContext, localMemorySource, type MemorySource } from ".";
import { learnFromExtraction, learnFromMessage, localMemoryWriter, type MemoryWriter } from "../memory-write";

let local: Record<string, unknown>;
function area(store: () => Record<string, unknown>) {
  return {
    get: async (key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(keys.map((name) => [name, structuredClone(store()[name])]));
    },
    set: async (value: Record<string, unknown>) => void Object.assign(store(), structuredClone(value)),
    remove: async () => undefined
  };
}

beforeEach(() => {
  local = {};
  parentDeps = null;
  helperDeps.length = 0;
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: { storage: { local: area(() => local), session: area(() => ({})) }, runtime: { sendMessage: async () => ({ ok: true, data: {} }) } }
  });
});

function fakeSource(calls: Array<{ read: string; spaceId: string; request?: string }>): MemorySource {
  const episode = { id: "fake-episode", title: "kettle task", task: "compare kettles", status: "completed", sites: ["shop.example"], space_id: "space-work" };
  return {
    id: "fake",
    currentState: async (spaceId) => {
      calls.push({ read: "currentState", spaceId });
      return {
        instructions: { space: "", global: "" },
        facts: { space: [{ id: "f1", text: "I prefer steel kettles", added_at: "2026-10-01T00:00:00.000Z", by: "you", status: "current" } as never], global: [] },
        decisions: [],
        walled: {},
        earlierCount: 0
      };
    },
    earlierState: async (request, spaceId) => {
      calls.push({ read: "earlierState", spaceId, request });
      return { facts: [], decisions: [], method: "words" };
    },
    relevantHistory: async (request, spaceId) => {
      calls.push({ read: "relevantHistory", spaceId, request });
      return { entries: [], inspected: 0 };
    },
    relevantEpisodes: async (request, spaceId) => {
      calls.push({ read: "relevantEpisodes", spaceId, request });
      return { episodes: [episode as never], walled: 0 };
    },
    relevantSkills: async (request, spaceId) => {
      calls.push({ read: "relevantSkills", spaceId, request });
      return { skills: [], inspected: 0, walled: 0 };
    }
  };
}

function fakeWriter(writes: Array<{ write: string; spaceId: string }>): MemoryWriter {
  const facts: Array<{ id: string; text: string; source: "you" | "learned"; created_at: string; status: "current" }> = [];
  return {
    id: "fake-writer",
    currentFacts: async () => ({ space: [...facts], global: [] }),
    writeFact: async (text, by, spaceId) => {
      writes.push({ write: "writeFact", spaceId });
      const fact = { id: crypto.randomUUID(), text, source: by, created_at: "2026-10-06T00:00:00.000Z", status: "current" as const };
      facts.push(fact);
      return fact;
    },
    instructions: async () => ({ space: "", global: "" }),
    saveInstructions: async (_text, _scope, spaceId) => {
      writes.push({ write: "saveInstructions", spaceId });
      return { ok: true };
    },
    currentDecisions: async () => [],
    writeDecision: async (input, spaceId) => {
      writes.push({ write: "writeDecision", spaceId });
      return { ok: true, decision: { id: "d1", type: "decision", subject: input.subject, value: input.value, scope: "space", status: "current", created_at: "", provenance: { by: "learned", space_id: spaceId, at: "" } } };
    },
    undoDecision: async () => true,
    recordTaskEpisode: async (evidence, spaceId) => {
      writes.push({ write: "recordTaskEpisode", spaceId });
      return { id: "episode", space_id: spaceId } as never;
    }
  };
}

describe("a task-fixed memory source", () => {
  it("is used for the compiled context, the agent's recall and every helper's recall, never the device store", async () => {
    const local = vi.spyOn(localMemorySource, "relevantEpisodes");
    const localState = vi.spyOn(localMemorySource, "currentState");
    const calls: Array<{ read: string; spaceId: string; request?: string }> = [];
    const source = fakeSource(calls);
    const writes: Array<{ write: string; spaceId: string }> = [];
    const localEpisode = vi.spyOn(localMemoryWriter, "recordTaskEpisode");

    const compiled = await compileContext({ request: "which steel kettle is best?", spaceId: "space-work", source, intent: "browser" });
    expect(compiled.sections.facts?.map((item) => item.text)).toEqual(["I prefer steel kettles"]);
    expect(calls.some((call) => call.read === "currentState")).toBe(true);

    const model = { id: "m", label: "m", provider: "openai-compatible", model: "test", baseUrl: "http://127.0.0.1:1/v1", apiKey: "x", chatHealth: { status: "healthy" }, agentHealth: { status: "healthy" }, embeddingHealth: { status: "unknown" } } as never;
    const result = await runAgentTask("compare kettles", {
      agentPrimary: model,
      agentFallback: null,
      session: { id: "task-1", title: "kettles" },
      spaceId: "space-work",
      memorySource: source,
      memoryWriter: fakeWriter(writes),
      signal: new AbortController().signal,
      hooks: {
        addActivity: () => "a",
        finishActivity: () => undefined,
        isCancelled: () => false,
        isPaused: () => false,
        approvalQuestion: () => null,
        requestApproval: async () => true,
        requestUserAction: async () => true
      } as never
    });
    expect(result.status).toBe("completed");
    expect(parentDeps).not.toBeNull();
    expect(helperDeps).toHaveLength(2);

    const recalls = calls.filter((call) => call.read === "relevantEpisodes");
    // One for the agent, one for each helper; all in the task's Space.
    expect(recalls.map((call) => call.request)).toEqual([
      "compare kettles shop.example",
      expect.stringMatching(/^check kettle A/),
      expect.stringMatching(/^check kettle B/)
    ]);
    expect(new Set(calls.map((call) => call.spaceId))).toEqual(new Set(["space-work"]));
    // The device's own store was never asked.
    expect(local).not.toHaveBeenCalled();
    expect(localState).not.toHaveBeenCalled();
    // What the task (and its helpers' findings, inside its record) observed went to the task's writer, in its Space.
    expect(writes).toEqual([{ write: "recordTaskEpisode", spaceId: "space-work" }]);
    expect(localEpisode).not.toHaveBeenCalled();
  });

  it("learning from the person's message, before and after the answer, writes through the one writer fixed for the chat", async () => {
    const writes: Array<{ write: string; spaceId: string }> = [];
    const writer = fakeWriter(writes);
    const spies = (["writeFact", "saveInstructions", "writeDecision", "currentFacts"] as const).map((name) => vi.spyOn(localMemoryWriter, name));
    const context = { spaceId: "space-work", chatId: "c1", writer };
    await learnFromMessage("I live in Mumbai. Let's use GitHub for this project from now on.", context);
    await learnFromExtraction(["I prefer steel kettles"], "I prefer steel kettles, find one", context);
    expect(writes.map((item) => item.write)).toEqual(["writeFact", "writeDecision", "writeFact"]);
    expect(new Set(writes.map((item) => item.spaceId))).toEqual(new Set(["space-work"]));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(local).toEqual({});
  });
});
