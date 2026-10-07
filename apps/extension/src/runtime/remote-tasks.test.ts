// Regression: a task from a chat app works in the Space that was in use when
// the message arrived, even if the person switches Space before it runs.
import { beforeEach, describe, expect, it, vi } from "vitest";

const agentCalls: Array<{ task: string; spaceId: string; context: string; memorySource?: unknown }> = [];
const chatCalls: Array<{ primary: string; fallback: string | null }> = [];

vi.mock("./model-router", async (importOriginal) => {
  const original = await importOriginal<typeof import("./model-router")>();
  return {
    ...original,
    directChatWithFallback: vi.fn(async (primary: { model: string }, fallback: { model: string } | null) => {
      chatCalls.push({ primary: primary.model, fallback: fallback?.model ?? null });
      return { result: "Here you go.", usedFallback: false };
    })
  };
});

vi.mock("./agent-task", async (importOriginal) => {
  const original = await importOriginal<typeof import("./agent-task")>();
  const { saveTaskEpisodeMemory } = await import("./task-memory");
  return {
    ...original,
    extensionMessage: vi.fn(async () => ({ ok: true, data: { tab_id: 7 } })),
    // Stands in for the browser run; records what it was given and, like the
    // real one, saves the episode in the Space it was handed.
    runAgentTask: vi.fn(async (task: string, options: { spaceId: string; context?: string; memorySource?: unknown }) => {
      agentCalls.push({ task, spaceId: options.spaceId, context: options.context ?? "", memorySource: options.memorySource });
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
import { compileContext, CONTEXT_DIAGNOSTICS_KEY, localMemorySource, renderContext } from "./context";
import { loadActiveConnection, loadFallbackConnection } from "../settings/provider-store";

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
  chatCalls.length = 0;
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

    // Each Space knows different things, worded alike (and relevant to the task) so a leak would show.
    await addFacts(["I prefer casual product descriptions"], "you", A);
    await addFacts(["I prefer formal product reports"], "you", B);
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

    // What the side panel would send for the same words in a new chat in Space A.
    const sidePanel = renderContext(
      await compileContext({ request: "publish kettle product like last time", spaceId: A, conversation: [], connection: await loadActiveConnection(), autoSkills: true, recall: true })
    );

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
    expect(call.context).toContain("I prefer casual product descriptions");
    expect(call.context).toContain("Prices in rupees");
    expect(call.context).toContain("₹1,499");
    expect(call.context).toContain("(/publish-kettle-product)");
    expect(call.context).not.toContain("formal product reports");
    expect(call.context).not.toContain("dollars");
    expect(call.context).not.toContain("Work kettle report");
    expect(call.context).not.toContain("/publish-kettle-product-report");
    // Same request, same Space: the same memory as from the side panel.
    expect(call.context).toBe(sidePanel);

    // …and everything it wrote went to Space A.
    expect((await listTaskEpisodeMemory(50, A)).map((episode) => episode.session_id)).toEqual(["remote-session"]);
    expect(await listTaskEpisodeMemory(50, B)).toEqual([]);
    expect((await loadTaskHistory(A))[0].task).toBe("From Telegram: publish kettle product like last time");
    // The answer is linked to the task's episode, so recall carries its verification (Phase 8).
    expect(outcome.session_id).toBe("remote-session");
    expect((await loadTaskHistory(A))[0].session_id).toBe("remote-session");
    expect((await loadTaskHistory(B)).map((entry) => entry.task)).toEqual(["publish kettle product"]);
    expect((await loadSkills(A)).find((item) => item.id === shopSkill.id)?.runs).toBe(1);
    expect((await loadSkills(B)).every((item) => item.runs === 0)).toBe(true);
    expect(session[REMOTE_TASKS_KEY]).toEqual({});
  });

  it("compile the context for every model that may receive it, and give the agent the same memory source", async () => {
    const backup = {
      id: "local",
      label: "Gemma on this computer",
      provider: "lm-studio",
      model: "gemma-4-e2b",
      baseUrl: "http://localhost:1234/v1",
      chatHealth: { status: "healthy" },
      agentHealth: { status: "healthy" },
      embeddingHealth: { status: "unknown" }
    };
    const routeOf = () => (session[CONTEXT_DIAGNOSTICS_KEY] as Array<{ budget: { target: number; route?: Record<string, unknown> } }>)[0].budget;

    // A chat-only request: the backup passed the chat check, so it limits the budget.
    vi.mocked(loadFallbackConnection).mockResolvedValueOnce(backup as never);
    const chatId = await enqueueRemoteTask("what is a good kettle wattage?", "telegram");
    expect((await runRemoteTask((await takeRemoteTask(chatId))!)).status).toBe("worked");
    expect(chatCalls).toEqual([{ primary: "test", fallback: "gemma-4-e2b" }]);
    // A chat-only answer has no task episode and stays unlinked.
    expect((await loadTaskHistory(DEFAULT_SPACE_ID))[0].session_id).toBeUndefined();
    expect(routeOf()).toMatchObject({ target: 1024, route: { intent: "chat", limited_by: "fallback", fallback: { model: "gemma-4-e2b" } } });

    // A browser task: the same backup passed browser control too, so it limits this budget as well.
    vi.mocked(loadFallbackConnection).mockResolvedValueOnce(backup as never);
    const browserId = await enqueueRemoteTask("open amazon.in and compare kettle prices", "telegram");
    expect((await runRemoteTask((await takeRemoteTask(browserId))!)).status).toBe("worked");
    expect(routeOf()).toMatchObject({ target: 1024, route: { intent: "browser", limited_by: "fallback" } });
    // The agent reads the same memory the context was compiled from.
    expect(agentCalls.at(-1)?.memorySource).toBe(localMemorySource);

    // A backup that failed the browser-control check never gets a browser task, so it doesn't shrink it.
    vi.mocked(loadFallbackConnection).mockResolvedValueOnce({ ...backup, agentHealth: { status: "failed" } } as never);
    const againId = await enqueueRemoteTask("open amazon.in and compare kettle prices", "telegram");
    await runRemoteTask((await takeRemoteTask(againId))!);
    expect(routeOf()).toMatchObject({ route: { limited_by: "primary", fallback: null, fallback_not_counted: "backup did not pass the browser-control check" } });
    // Models are named, never their keys or addresses.
    expect(JSON.stringify(session[CONTEXT_DIAGNOSTICS_KEY])).not.toMatch(/apiKey|localhost|127\.0\.0\.1/);
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
