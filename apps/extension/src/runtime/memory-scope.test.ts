// Memory v2, Phase 2: a Space is a hard wall for everything remembered.
// These tests write near-identical memories into two Spaces and check that
// no search, list, recall or delete in one Space ever reaches the other.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordSpace, visibleInSpace, withinSpace } from "./memory-scope";
import {
  createSpace,
  deleteSpace,
  DEFAULT_SPACE_ID,
  pinSpace,
  SPACE_TAGGED_KEYS,
  switchSpace
} from "./spaces";
import {
  deleteTaskEpisodeMemory,
  getTaskEpisodeMemory,
  listTaskEpisodeMemory,
  saveTaskEpisodeMemory,
  searchTaskEpisodeMemory,
  TASK_EPISODE_MEMORY_KEY
} from "./task-memory";
import { searchTaskMemoryHybrid } from "./semantic-memory";
import {
  deleteSkill,
  loadAllSkills,
  loadSkills,
  saveSkill,
  SKILLS_STORAGE_KEY,
  type UserSkill
} from "./skills";
import { applyLearningPlan, MAX_AUTO_SKILLS, matchSkill } from "./skill-learning";
import { addFacts, loadAboutMe } from "./about-me";
import { loadInstructions, saveInstructions } from "./instructions";
import { loadTaskHistory, saveTaskHistoryEntry } from "./history";
import { recallFor } from "./recall";
import * as providerStore from "../settings/provider-store";
import * as modelClient from "./model-client";
import type { BrowserTaskSessionEvidence } from "./session-evidence";

let store: Record<string, unknown>;

beforeEach(() => {
  vi.restoreAllMocks();
  store = {};
  pinSpace(null);
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          get: async (key: string | string[]) => {
            const keys = Array.isArray(key) ? key : [key];
            return Object.fromEntries(keys.map((name) => [name, structuredClone(store[name])]));
          },
          set: async (value: Record<string, unknown>) => {
            Object.assign(store, structuredClone(value));
          },
          remove: async (keys: string | string[]) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
          }
        }
      }
    }
  });
  vi.spyOn(providerStore, "loadEmbeddingConnection").mockResolvedValue(null);
});

function evidence(id: string, task: string, url: string, helperSource?: string): BrowserTaskSessionEvidence {
  return {
    version: 1,
    session_id: id,
    title: task,
    task,
    started_at: `2026-10-06T10:00:0${id.length % 10}.000Z`,
    status: "completed",
    start: { tab_id: 1, url, title: task },
    actions: [
      {
        id: "action-1",
        ordinal: 1,
        recorded_at: "2026-10-06T10:00:03.000Z",
        tool: helperSource ? "agent" : "click",
        input: {},
        note: "step",
        before: { tab_id: 1, url, title: task },
        target: { element_id: "@e1", tag: "button", role: "button", accessible_name: "Publish product" },
        approval: { required: false, approved: true },
        ...(helperSource
          ? {
              delegation: {
                worker_count: 1,
                completed_count: 1,
                non_completed_count: 0,
                workers: [
                  {
                    index: 0,
                    task: "Find supplier prices",
                    session_id: `${id}:worker:1`,
                    status: "completed" as const,
                    sources: [{ url: helperSource, title: "Supplier list" }],
                    tools_used: ["navigate", "read_page"]
                  }
                ]
              }
            }
          : {})
      }
    ],
    tab_evidence: []
  };
}

function skill(name: string, extra: Partial<UserSkill> = {}): UserSkill {
  return {
    id: crypto.randomUUID(),
    name,
    slug: "",
    description: name,
    instructions: "1. Open the shop\n2. Fill the form\n3. Press Publish",
    source: "auto",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    runs: 0,
    successes: 0,
    failures: 0,
    lessons: [],
    ...extra
  };
}

async function twoSpaces() {
  const work = await createSpace("Work", { switchTo: false });
  const shop = await createSpace("PujaPrem", { switchTo: false });
  if (!work.ok || !shop.ok) throw new Error("spaces");
  return { work: work.space.id, shop: shop.space.id };
}

describe("the Space wall", () => {
  it("treats untagged (older) records as the first Space, and shared ones as everywhere", () => {
    expect(recordSpace({})).toBe(DEFAULT_SPACE_ID);
    expect(visibleInSpace({}, DEFAULT_SPACE_ID)).toBe(true);
    expect(visibleInSpace({}, "work")).toBe(false);
    expect(visibleInSpace({ space_id: "work" }, "work")).toBe(true);
    expect(visibleInSpace({ space_id: "work" }, "shop")).toBe(false);
    expect(visibleInSpace({ space_id: "work", visibility: "all" }, "shop")).toBe(true);
    expect(withinSpace([{ space_id: "a" }, { space_id: "b" }, {}], "b")).toEqual([{ space_id: "b" }]);
  });
});

describe("past tasks (episodes) stay in their Space", () => {
  it("never finds another Space's task, even with the same words", async () => {
    const { work, shop } = await twoSpaces();
    await saveTaskEpisodeMemory(evidence("s-shop", "Publish Shopify product kettle", "https://shop.example/admin"), shop);
    await saveTaskEpisodeMemory(evidence("s-work", "Publish Shopify product kettle report", "https://work.example/admin"), work);

    const inShop = await searchTaskEpisodeMemory("publish shopify product kettle", 10, shop);
    expect(inShop.map((item) => item.session_id)).toEqual(["s-shop"]);
    const inWork = await searchTaskEpisodeMemory("publish shopify product kettle", 10, work);
    expect(inWork.map((item) => item.session_id)).toEqual(["s-work"]);
    expect(await searchTaskEpisodeMemory("publish shopify product kettle", 10, DEFAULT_SPACE_ID)).toEqual([]);
    expect((await listTaskEpisodeMemory(50, shop)).map((item) => item.space_id)).toEqual([shop]);
  });

  it("keeps the wall when the meaning search would rank the other Space first", async () => {
    const { work, shop } = await twoSpaces();
    vi.spyOn(providerStore, "loadEmbeddingConnection").mockResolvedValue({
      id: "embed-1",
      label: "Local embeddings",
      provider: "openai-compatible",
      apiKey: "x",
      model: "bge-small-en",
      baseUrl: "http://127.0.0.1:1234/v1",
      capabilities: { chat: false, agent: false, vision: false, embedding: true, reranker: false, audio: false, image: false, unknown: false },
      chatHealth: { status: "unknown" },
      agentHealth: { status: "unknown" },
      embeddingHealth: { status: "healthy" }
    } as Awaited<ReturnType<typeof providerStore.loadEmbeddingConnection>>);
    // Every text embeds to the same vector: a perfect "semantic" match everywhere.
    vi.spyOn(modelClient, "embedTexts").mockImplementation(async (_connection, texts) => ({
      vectors: texts.map(() => [1, 0, 0]),
      dimensions: 3
    }) as Awaited<ReturnType<typeof modelClient.embedTexts>>);

    await saveTaskEpisodeMemory(evidence("s-shop", "Supplier shortlist for incense", "https://shop.example"), shop);
    await saveTaskEpisodeMemory(evidence("s-work", "Quarterly board deck", "https://work.example"), work);

    const hits = await searchTaskMemoryHybrid("anything at all", 10, work);
    expect(hits.map((hit) => hit.episode.session_id)).toEqual(["s-work"]);
    expect(hits.every((hit) => hit.episode.space_id === work)).toBe(true);
  });

  it("reads, gets and deletes only inside the asking Space", async () => {
    const { work, shop } = await twoSpaces();
    const episode = await saveTaskEpisodeMemory(evidence("s-shop", "Publish product", "https://shop.example"), shop);
    expect(await getTaskEpisodeMemory(episode.id, work)).toBeNull();
    expect(await deleteTaskEpisodeMemory(episode.id, work)).toBe(false);
    expect(await getTaskEpisodeMemory(episode.id, shop)).not.toBeNull();
    expect(await deleteTaskEpisodeMemory(episode.id, shop)).toBe(true);
  });

  it("files episodes saved before Spaces under the first Space", async () => {
    const { work } = await twoSpaces();
    await saveTaskEpisodeMemory(evidence("s-old", "Old kettle search", "https://old.example"), DEFAULT_SPACE_ID);
    const stored = store[TASK_EPISODE_MEMORY_KEY] as Array<Record<string, unknown>>;
    delete stored[0].space_id; // as written before Memory v2
    expect((await searchTaskEpisodeMemory("kettle", 10, DEFAULT_SPACE_ID)).map((item) => item.session_id)).toEqual(["s-old"]);
    expect(await searchTaskEpisodeMemory("kettle", 10, work)).toEqual([]);
  });

  it("uses the Space in use when no task Space is given", async () => {
    const { shop } = await twoSpaces();
    await switchSpace(shop);
    const episode = await saveTaskEpisodeMemory(evidence("s-1", "Publish product", "https://shop.example"));
    expect(episode.space_id).toBe(shop);
  });

  it("keeps a helper's findings with the parent task's Space and source", async () => {
    const { work, shop } = await twoSpaces();
    const episode = await saveTaskEpisodeMemory(
      evidence("s-parent", "Compare suppliers", "https://shop.example", "https://supplier.example/list"),
      shop
    );
    expect(episode.space_id).toBe(shop);
    expect(episode.delegations?.[0]).toMatchObject({
      session_id: "s-parent:worker:1",
      sources: [{ url: "https://supplier.example/list", title: "Supplier list" }],
      tools_used: ["navigate", "read_page"]
    });
    expect(await searchTaskEpisodeMemory("supplier.example", 10, work)).toEqual([]);
  });

  it("limits each Space on its own, so a busy Space never pushes out another's", async () => {
    const { work, shop } = await twoSpaces();
    await saveTaskEpisodeMemory(evidence("s-keep", "Shop task", "https://shop.example"), shop);
    for (let index = 0; index < 505; index += 1) {
      await saveTaskEpisodeMemory(evidence(`w-${index}`, `Work task ${index}`, "https://work.example"), work);
    }
    expect(await listTaskEpisodeMemory(100, shop)).toHaveLength(1);
    const all = store[TASK_EPISODE_MEMORY_KEY] as unknown[];
    expect(all).toHaveLength(501);
  }, 20_000);
});

describe("Skills belong to the Space they were made in", () => {
  it("offers a learned Skill only in its own Space", async () => {
    const { work, shop } = await twoSpaces();
    await applyLearningPlan({ kind: "learn", skill: skill("Publish Shopify product") }, [], shop);
    expect((await loadSkills(shop)).map((item) => item.name)).toEqual(["Publish Shopify product"]);
    expect(await loadSkills(work)).toEqual([]);
    expect(await loadSkills(DEFAULT_SPACE_ID)).toEqual([]);
    // Not even as a hint for a near-identical request.
    expect(matchSkill("publish shopify product", await loadSkills(work))).toBeNull();
    expect(matchSkill("publish shopify product", await loadSkills(shop))?.skill.name).toBe("Publish Shopify product");
  });

  it("keeps Skills saved before Spaces working in every Space", async () => {
    const { work } = await twoSpaces();
    store[SKILLS_STORAGE_KEY] = [{ ...skill("Old helper"), slug: "old-helper", source: "chat" }];
    expect((await loadSkills(work)).map((item) => item.slug)).toEqual(["old-helper"]);
    expect((await loadSkills(DEFAULT_SPACE_ID)).map((item) => item.slug)).toEqual(["old-helper"]);
  });

  it("never deletes another Space's Skill", async () => {
    const { work, shop } = await twoSpaces();
    const saved = await saveSkill(skill("Publish product"), [], shop);
    await deleteSkill(saved.id, work);
    expect(await loadSkills(shop)).toHaveLength(1);
    await deleteSkill(saved.id, shop);
    expect(await loadSkills(shop)).toHaveLength(0);
  });

  it("keeps /commands unique across Spaces and keeps a Skill's Space when it changes", async () => {
    const { work, shop } = await twoSpaces();
    const first = await saveSkill(skill("Publish"), [], shop);
    const second = await saveSkill(skill("Publish"), [], work);
    expect(first.slug).toBe("publish");
    expect(second.slug).toBe("publish-2");
    // Updated from anywhere, it stays where it was made.
    const updated = await saveSkill({ ...first, instructions: "1. New" }, [], work);
    expect(updated.space_id).toBe(shop);
  });

  it("makes room only among the learning Space's own unused Skills", async () => {
    const { work, shop } = await twoSpaces();
    for (let index = 0; index < MAX_AUTO_SKILLS; index += 1) {
      await saveSkill(skill(`Work skill ${index}`, { created_at: `2026-10-01T00:00:${String(index).padStart(2, "0")}.000Z` }), [], work);
    }
    for (let index = 0; index < 3; index += 1) {
      await applyLearningPlan({ kind: "learn", skill: skill(`Shop skill ${index}`) }, [], shop);
    }
    expect(await loadSkills(work)).toHaveLength(MAX_AUTO_SKILLS);
    await applyLearningPlan({ kind: "learn", skill: skill("One more work skill") }, [], work);
    expect(await loadSkills(work)).toHaveLength(MAX_AUTO_SKILLS);
    expect(await loadSkills(shop)).toHaveLength(3);
  });
});

describe("a task keeps the Space it started in", () => {
  it("reads and writes notes, instructions and history in the given Space, whatever is in use now", async () => {
    const { work, shop } = await twoSpaces();
    await switchSpace(work); // the person switched while a PujaPrem task ran
    await addFacts(["I prefer formal reports"], "you", work);
    await addFacts(["I prefer casual writing"], "learned", shop);
    await saveTaskHistoryEntry({ task: "kettles compared", result: "Prestige vs Philips" }, shop);
    await saveInstructions("Use technical words");

    expect((await loadAboutMe(shop)).map((fact) => fact.text)).toEqual(["I prefer casual writing"]);
    expect((await loadAboutMe(work)).map((fact) => fact.text)).toEqual(["I prefer formal reports"]);
    expect((await loadTaskHistory(shop)).map((entry) => entry.task)).toEqual(["kettles compared"]);
    expect(await loadTaskHistory(work)).toEqual([]);
    expect(await loadInstructions(work)).toBe("Use technical words");
    expect(await loadInstructions(shop)).toBe("");
  });

  it("recalls past conversations from the current Space only", async () => {
    const { work, shop } = await twoSpaces();
    await saveTaskHistoryEntry({ task: "What kettles did I compare", result: "Prestige and Philips kettles" }, shop);
    await saveTaskHistoryEntry({ task: "Board meeting notes", result: "Agenda drafted" }, work);
    expect(recallFor(await loadTaskHistory(work), "what kettles did I compare last week?")).toEqual([]);
    expect(recallFor(await loadTaskHistory(shop), "what kettles did I compare last week?")).toHaveLength(1);
  });
});

describe("deleting a Space", () => {
  it("removes its own past tasks and Skills, and nothing from other Spaces", async () => {
    const { work, shop } = await twoSpaces();
    store[SKILLS_STORAGE_KEY] = [{ ...skill("Shared older skill"), slug: "shared" }];
    await saveSkill(skill("Shop skill"), [], shop);
    await saveSkill(skill("Work skill"), [], work);
    await saveTaskEpisodeMemory(evidence("s-shop", "Shop task", "https://shop.example"), shop);
    await saveTaskEpisodeMemory(evidence("s-work", "Work task", "https://work.example"), work);

    await deleteSpace(shop);

    expect((await loadAllSkills()).map((item) => item.name).sort()).toEqual(["Shared older skill", "Work skill"]);
    expect((store[TASK_EPISODE_MEMORY_KEY] as Array<{ session_id: string }>).map((item) => item.session_id)).toEqual(["s-work"]);
  });

  it("uses the same storage keys as the stores it cleans", () => {
    expect(SPACE_TAGGED_KEYS.skills).toBe(SKILLS_STORAGE_KEY);
    expect(SPACE_TAGGED_KEYS.episodes).toBe(TASK_EPISODE_MEMORY_KEY);
  });
});
