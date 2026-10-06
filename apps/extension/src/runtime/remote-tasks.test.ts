// Regression: a task from a chat app works in the Space that was in use when
// the message arrived, even if the person switches Space before it runs.
import { beforeEach, describe, expect, it, vi } from "vitest";

const agentCalls: Array<{ task: string; spaceId: string; context: string }> = [];

vi.mock("./agent-task", async (importOriginal) => {
  const original = await importOriginal<typeof import("./agent-task")>();
  const { saveTaskEpisodeMemory } = await import("./task-memory");
  return {
    ...original,
    extensionMessage: vi.fn(async () => ({ ok: true, data: { tab_id: 7 } })),
    // Stands in for the browser run; records what it was given and, like the
    // real one, saves the episode in the Space it was handed.
    runAgentTask: vi.fn(async (task: string, options: { spaceId: string; context?: string }) => {
      agentCalls.push({ task, spaceId: options.spaceId, context: options.context ?? "" });
      const evidence = {
        version: 1,
        session_id: "remote-session",
        title: task,
        task,
        started_at: "2026-10-06T12:00:00.000Z",
        status: "completed",
        start: { tab_id: 7, url: "https://shop.example/admin", title: "Shop" },
        actions: [],
        tab_evidence: []
      };
      await saveTaskEpisodeMemory(evidence as never, options.spaceId);
      return { status: "completed", message: "Published the kettle.", session_evidence: evidence };
    })
  };
});

vi.mock("../settings/provider-store", async (importOriginal) => {
  const original = await importOriginal<typeof import("../settings/provider-store")>();
  const model = {
    id: "m1",
    label: "Test model",
    provider: "openai-compatible",
    apiKey: "x",
    model: "test",
    baseUrl: "http://127.0.0.1:1/v1",
    capabilities: { chat: true, agent: true, vision: false, embedding: false, reranker: false, audio: false, image: false, unknown: false },
    chatHealth: { status: "healthy" },
    agentHealth: { status: "healthy" },
    embeddingHealth: { status: "unknown" }
  };
  return {
    ...original,
    hasCredentials: () => true,
    loadActiveConnection: vi.fn(async () => model),
    loadFallbackConnection: vi.fn(async () => null),
    loadEmbeddingConnection: vi.fn(async () => null)
  };
});

import { enqueueRemoteTask, REMOTE_TASKS_KEY, takeRemoteTask } from "./remote-queue";
import { runRemoteTask } from "./remote-tasks";
import { createSpace, DEFAULT_SPACE_ID, pinSpace, switchSpace } from "./spaces";
import { addFacts } from "./about-me";
import { saveInstructions } from "./instructions";
import { loadTaskHistory, saveTaskHistoryEntry } from "./history";
import { loadSkills, saveSkill, type UserSkill } from "./skills";
import { listTaskEpisodeMemory } from "./task-memory";

let local: Record<string, unknown>;
let session: Record<string, unknown>;

function area(store: () => Record<string, unknown>) {
  return {
    get: async (key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(keys.map((name) => [name, structuredClone(store()[name])]));
    },
    set: async (value: Record<string, unknown>) => {
      Object.assign(store(), structuredClone(value));
    },
    remove: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store()[key];
    }
  };
}

beforeEach(() => {
  local = {};
  session = {};
  agentCalls.length = 0;
  pinSpace(null);
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: { storage: { local: area(() => local), session: area(() => session) } }
  });
});

function skill(name: string): UserSkill {
  return {
    id: crypto.randomUUID(),
    name,
    slug: "",
    description: name,
    instructions: "1. Open the shop\n2. Fill the form\n3. Press Publish",
    source: "chat",
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    runs: 0,
    successes: 0,
    failures: 0,
    lessons: []
  };
}

describe("tasks from chat apps", () => {
  it("stay in the Space that was in use when the message arrived", async () => {
    const a = await createSpace("Shop", { switchTo: false });
    const b = await createSpace("Work", { switchTo: false });
    if (!a.ok || !b.ok) throw new Error("spaces");
    const A = a.space.id;
    const B = b.space.id;

    // Each Space knows different things, worded alike so a leak would show.
    await addFacts(["I prefer casual writing"], "you", A);
    await addFacts(["I prefer formal reports"], "you", B);
    await switchSpace(A);
    await saveInstructions("Prices in rupees");
    await switchSpace(B);
    await saveInstructions("Prices in dollars");
    await saveTaskHistoryEntry({ task: "publish kettle product", result: "Shop kettle listed at ₹1,499" }, A);
    await saveTaskHistoryEntry({ task: "publish kettle product", result: "Work kettle report sent" }, B);
    const shopSkill = await saveSkill(skill("Publish kettle product"), [], A);
    await saveSkill(skill("Publish kettle product report"), [], B);

    // 1. Space A is in use. 2. The message arrives and is queued.
    await switchSpace(A);
    const id = await enqueueRemoteTask("publish kettle product like last time", "telegram");
    expect((session[REMOTE_TASKS_KEY] as Record<string, { space_id?: string }>)[id].space_id).toBe(A);

    // 3. The person switches to Space B. 4. The runner starts.
    await switchSpace(B);
    const request = await takeRemoteTask(id);
    expect(request?.space_id).toBe(A);
    const outcome = await runRemoteTask(request!);
    expect(outcome.status).toBe("worked");

    // 5. Everything the task read came from Space A…
    expect(agentCalls).toHaveLength(1);
    const call = agentCalls[0];
    expect(call.spaceId).toBe(A);
    expect(call.context).toContain("I prefer casual writing");
    expect(call.context).toContain("Prices in rupees");
    expect(call.context).toContain("₹1,499");
    expect(call.context).toContain("(/publish-kettle-product)");
    expect(call.context).not.toContain("formal reports");
    expect(call.context).not.toContain("dollars");
    expect(call.context).not.toContain("Work kettle report");
    expect(call.context).not.toContain("/publish-kettle-product-report");

    // …and everything it wrote went to Space A.
    expect((await listTaskEpisodeMemory(50, A)).map((episode) => episode.session_id)).toEqual(["remote-session"]);
    expect(await listTaskEpisodeMemory(50, B)).toEqual([]);
    expect((await loadTaskHistory(A))[0].task).toBe("From Telegram: publish kettle product like last time");
    expect((await loadTaskHistory(B)).map((entry) => entry.task)).toEqual(["publish kettle product"]);
    expect((await loadSkills(A)).find((item) => item.id === shopSkill.id)?.runs).toBe(1);
    expect((await loadSkills(B)).every((item) => item.runs === 0)).toBe(true);
    expect(session[REMOTE_TASKS_KEY]).toEqual({});
  });

  it("falls back to the Space in use for a message queued before Spaces were recorded", async () => {
    const b = await createSpace("Work", { switchTo: true });
    if (!b.ok) throw new Error("space");
    session[REMOTE_TASKS_KEY] = { old: { text: "check prices", from: "slack", created_at: "2026-10-06T11:00:00.000Z" } };
    expect((await takeRemoteTask("old"))?.space_id).toBe(b.space.id);
    expect(await takeRemoteTask("old")).toBeNull();
  });

  it("queues in the first Space when no other Space exists", async () => {
    const id = await enqueueRemoteTask("hello", "signal");
    expect((await takeRemoteTask(id))?.space_id).toBe(DEFAULT_SPACE_ID);
  });
});
