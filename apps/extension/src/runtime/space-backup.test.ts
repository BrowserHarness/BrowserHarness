// Memory v2 Phase 9: a Space backup holds what the Space owns (not everything
// it can see), and restoring it makes an independent copy with new ids for
// shared-store records and every link between them rewritten.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addFacts, earlierFactsFor, loadAboutMe, loadEarlierFacts, loadGlobalAboutMe, updateFact } from "./about-me";
import { loadChats, saveChatMessages } from "./chats";
import { currentDecisions, earlierDecisionsFor, MAX_DECISIONS, recordDecision, type Decision } from "./decisions";
import { loadTaskHistory, saveTaskHistoryEntry } from "./history";
import { CONTRADICTED_ANSWER } from "./history-verification";
import { loadGlobalInstructions, loadInstructions, saveGlobalInstructions, saveInstructions } from "./instructions";
import { recallCommand } from "./recall";
import { loadSchedules, MAX_SCHEDULES, newScheduledTask, saveScheduledTask, setScheduleEnabled } from "./schedules";
import type { BrowserSessionActionEvidence, BrowserTaskSessionEvidence } from "./session-evidence";
import { loadAllSkills, loadSkills, MAX_SKILLS, recordSkillRun, saveSkill, setSkillReach, type UserSkill } from "./skills";
import { backupSpace, parseSpaceBackup, restoreSpace, restoreSummary, spaceContents, type SpaceBackupV2 } from "./space-backup";
import { createSpace, DEFAULT_SPACE_ID, deleteSpace, loadSpaces, pinSpace, SCHEDULES_KEY, SPACE_TAGGED_KEYS } from "./spaces";
import { runTaskDag, type TaskDagNodeSpec } from "./task-dag";
import { MAX_EPISODES, saveTaskEpisodeMemory, searchTaskEpisodeMemory, TASK_EPISODE_MEMORY_KEY, type TaskEpisodeMemory } from "./task-memory";
import { dagEvidenceFromResult } from "./task-provenance";
import { TASK_EPISODE_VECTOR_KEY } from "./semantic-memory";

let local: Record<string, unknown>;
let failNextSet = false;
function area(store: () => Record<string, unknown>) {
  return {
    get: async (key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(keys.filter((name) => name in store()).map((name) => [name, structuredClone(store()[name])]));
    },
    set: async (value: Record<string, unknown>) => {
      if (failNextSet && Object.keys(value).length > 1) {
        failNextSet = false;
        throw new Error("QUOTA_BYTES quota exceeded");
      }
      Object.assign(store(), structuredClone(value));
    },
    remove: async (key: string | string[]) => {
      for (const name of Array.isArray(key) ? key : [key]) delete store()[name];
    }
  };
}

beforeEach(() => {
  local = {};
  failNextSet = false;
  pinSpace(null);
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: { storage: { local: area(() => local), session: area(() => ({})) } }
  });
});

const WORK = "work";
const OTHER = "other";
const ANSWER = "Vendor A has a free plan for everyone.";

async function spaces(): Promise<void> {
  await createSpace("Work", { id: WORK, switchTo: false });
  await createSpace("Home", { id: OTHER, switchTo: false });
}

function skill(name: string, extra: Partial<UserSkill> = {}): UserSkill {
  const now = "2026-10-01T00:00:00.000Z";
  return {
    id: crypto.randomUUID(),
    name,
    slug: "",
    description: `${name} steps`,
    instructions: "1. Open the billing page\n2. Pay the newest invoice",
    source: "chat",
    created_at: now,
    updated_at: now,
    runs: 5,
    successes: 4,
    failures: 1,
    lessons: ["The pay button is at the bottom"],
    ...extra
  };
}

const spec = (id: string, task: string, type: "research" | "verify" = "research", dependencies: string[] = []): TaskDagNodeSpec => ({ id, task, type, dependencies, step_budget: 8 });

function action(id: string, extra: Partial<BrowserSessionActionEvidence> = {}): BrowserSessionActionEvidence {
  const page = { tab_id: 1, url: "https://vendor-a.example/", title: "Vendor A" };
  return { id, ordinal: 1, recorded_at: "2026-10-07T00:00:00.000Z", tool: "agent", input: {}, note: "", before: page, approval: { required: false, approved: true }, ...extra };
}

/** Research says Vendor A has a free plan, the verifier contradicts it, the parent answer repeats it anyway. */
async function contradictedTask(sessionId: string, spaceId: string): Promise<void> {
  const result = await runTaskDag(
    [spec("research-1", "Find whether Vendor A has a free plan"), spec("verify-1", "Check the free plan claim", "verify", ["research-1"])],
    async ({ node }) => ({
      status: "completed",
      message: node.type === "verify" ? "VERDICT: contradicted. The regulator lists no free plan." : "Vendor A has a free plan.",
      steps: 1,
      session_id: `${sessionId}:worker:${node.id}`,
      sources: [{ url: node.type === "verify" ? "https://regulator.example/a" : "https://vendor-a.example/pricing", title: "Page" }],
      tools_used: ["read_page"]
    })
  );
  const dag = dagEvidenceFromResult(result)!;
  const evidence: BrowserTaskSessionEvidence = {
    version: 1,
    session_id: sessionId,
    title: "Vendor A plans",
    task: "Check whether Vendor A has a free plan",
    started_at: "2026-10-07T00:00:00.000Z",
    status: "completed",
    start: { tab_id: 1, url: "https://vendor-a.example/", title: "Vendor A" },
    actions: [
      action("action-1", { delegation: { kind: "dag", worker_count: dag.nodes.length, completed_count: dag.completed_count, non_completed_count: 0, workers: [], dag } }),
      action("action-2", {
        tool: "agent",
        delegation: {
          kind: "batch",
          mode: "read",
          worker_count: 1,
          completed_count: 1,
          non_completed_count: 0,
          workers: [{ index: 0, task: "Read the Vendor A blog", session_id: `${sessionId}:worker:0:abc`, status: "completed", sources: [{ url: "https://vendor-a.example/blog", title: "Blog" }], tools_used: ["read_page"] }]
        }
      })
    ],
    tab_evidence: []
  };
  await saveTaskEpisodeMemory(evidence, spaceId);
  await saveTaskHistoryEntry({ task: "Check whether Vendor A has a free plan", result: ANSWER, url: "https://vendor-a.example/", session_id: sessionId }, spaceId);
}

/** A Work Space with one of everything it can own, plus things it must not own. */
async function fullWork(): Promise<{ payInvoice: UserSkill }> {
  await spaces();
  await saveChatMessages("chat-1", [{ id: "m1", role: "user", text: "Plan the vendor review" }], WORK);
  await addFacts(["I live in Mumbai"], "you", WORK);
  await addFacts(["I live in Pune"], "you", WORK);
  await addFacts(["I prefer short answers"], "you", WORK);
  await saveInstructions("Prices in rupees", WORK);
  await recordDecision({ subject: "Code home", value: "Forgejo" }, WORK);
  await recordDecision({ subject: "Code home", value: "GitHub", rationale: "the team is there" }, WORK);
  const payInvoice = await saveSkill(skill("Pay invoice"), [], WORK);
  await contradictedTask("task-1", WORK);
  await saveScheduledTask({ ...newScheduledTask("/pay-invoice for this month", { kind: "daily", time: "08:00", days: [1] }), space_id: WORK, deliver_to: "telegram" });
  // Shared with every Space, or another Space's own: never in Work's backup.
  await addFacts(["My name is Asha"], "you", WORK, "global");
  await saveGlobalInstructions("Always answer in English");
  await recordDecision({ subject: "Browser", value: "Chrome", scope: "global" }, WORK);
  const everywhere = await saveSkill(skill("Check weather"), [], WORK);
  await setSkillReach(everywhere.id, "every-space", WORK);
  local[SPACE_TAGGED_KEYS.skills] = [...(local[SPACE_TAGGED_KEYS.skills] as UserSkill[]), { ...skill("Old shared"), slug: "old-shared" }];
  await saveSkill(skill("Home budget"), [], OTHER);
  await recordDecision({ subject: "Groceries", value: "BigBasket" }, OTHER);
  await addFacts(["I live in Goa"], "you", OTHER);
  await contradictedTask("task-home", OTHER);
  await saveScheduledTask({ ...newScheduledTask("water the plants", { kind: "interval", minutes: 60 }), space_id: OTHER });
  return { payInvoice };
}

async function roundTrip(spaceId = WORK) {
  const file = JSON.stringify(await backupSpace(spaceId));
  const parsed = parseSpaceBackup(file);
  if (!parsed) throw new Error("not a backup");
  const result = await restoreSpace(parsed);
  if (!result.ok) throw new Error(result.error);
  return { file, result, copy: result.space.id };
}

const episodes = () => (local[TASK_EPISODE_MEMORY_KEY] as TaskEpisodeMemory[]) ?? [];
const decisions = () => (local[SPACE_TAGGED_KEYS.decisions] as Decision[]) ?? [];

describe("what a backup holds", () => {
  it("is version 2 with the Space's own stores, its records in shared stores and its schedules", async () => {
    await fullWork();
    const backup = await backupSpace(WORK);
    expect(backup).toMatchObject({ kind: "browserharness-space-backup", version: 2, source_space: { id: WORK, name: "Work" } });
    expect(backup.manifest.counts).toMatchObject({ chats: 1, facts: 2, earlier_facts: 1, instructions: 1, history: 1, decisions: 1, earlier_decisions: 1, skills: 1, episodes: 1, dag_runs: 1, schedules: 1 });
    expect(backup.manifest.left_out.join(" ")).toMatch(/every Space/);
  });

  it("holds what the Space owns, never what is shared with every Space", async () => {
    await fullWork();
    const text = JSON.stringify(await backupSpace(WORK));
    for (const shared of ["My name is Asha", "Always answer in English", "Chrome", "Check weather", "Old shared"]) expect(text).not.toContain(shared);
  });

  it("holds nothing from another Space", async () => {
    await fullWork();
    const text = JSON.stringify(await backupSpace(WORK));
    for (const theirs of ["Home budget", "BigBasket", "I live in Goa", "task-home", "water the plants"]) expect(text).not.toContain(theirs);
  });

  it("never holds derived indexes or short-lived data", async () => {
    await fullWork();
    local[TASK_EPISODE_VECTOR_KEY] = [{ episode_id: episodes()[0].id, vector: [1, 2, 3] }];
    local["browserharness.contextDiagnostics"] = [{ x: 1 }];
    local["browserharness.workingMemory.v1"] = { note: "scratch" };
    const text = JSON.stringify(await backupSpace(WORK));
    expect(text).not.toContain("vector");
    expect(text).not.toContain("scratch");
    expect(text).not.toContain("contextDiagnostics");
  });
});

describe("restoring a v2 backup", () => {
  it("brings everything back as a new Space beside the original", async () => {
    await fullWork();
    const { result, copy } = await roundTrip();
    expect(result.space.name).toBe("Work (2)");
    expect(result.restored).toEqual({ chats: 1, facts: 2, earlier_facts: 1, instructions: true, history: 1, decisions: 1, earlier_decisions: 1, skills: 1, episodes: 1, schedules: 1 });
    expect(result.warnings).toEqual([]);
    expect((await loadSpaces()).active.id).toBe(DEFAULT_SPACE_ID);
    expect((await loadChats(copy)).map((chat) => chat.id)).toEqual(["chat-1"]);
    expect((await loadAboutMe(copy)).map((fact) => fact.text).sort()).toEqual(["I live in Pune", "I prefer short answers"]);
    expect((await loadEarlierFacts(copy)).map((fact) => fact.text)).toEqual(["I live in Mumbai"]);
    expect(await loadInstructions(copy)).toBe("Prices in rupees");
    expect((await loadTaskHistory(copy))[0].result).toBe(ANSWER);
    expect((await currentDecisions(copy)).map((item) => `${item.subject}: ${item.value}`)).toEqual(["Code home: GitHub", "Browser: Chrome"]);
    expect((await loadSkills(copy)).map((item) => item.name).sort()).toEqual(["Check weather", "Old shared", "Pay invoice"]);
    expect(restoreSummary(result)).toEqual([
      "1 chat",
      "2 remembered facts (and 1 from before)",
      "your wishes for this Space",
      "1 decision (and 1 earlier)",
      "1 Skill",
      "1 past task (1 with what was checked along the way)",
      "1 scheduled task (paused until you turn it on)"
    ]);
  });

  it("keeps a fact's history, so questions about the past still work", async () => {
    await fullWork();
    const { copy } = await roundTrip();
    const [old] = await loadEarlierFacts(copy);
    const [now] = (await loadAboutMe(copy)).filter((fact) => fact.text === "I live in Pune");
    expect(old).toMatchObject({ status: "superseded", superseded_by: now.id });
    expect(now.supersedes).toBe(old.id);
    expect(old.valid_until).toBeTruthy();
    expect(old.provenance?.space_id).toBe(copy);
    expect((await earlierFactsFor("Where did I live before Pune?", copy)).map((fact) => fact.text)).toEqual(["I live in Mumbai"]);
  });

  it("gives decisions new ids and keeps their history linked", async () => {
    await fullWork();
    const before = decisions().filter((item) => item.space_id === WORK);
    const { copy } = await roundTrip();
    const restored = decisions().filter((item) => item.space_id === copy);
    expect(restored).toHaveLength(2);
    for (const item of restored) expect(before.map((old) => old.id)).not.toContain(item.id);
    const github = restored.find((item) => item.value === "GitHub")!;
    const forgejo = restored.find((item) => item.value === "Forgejo")!;
    expect(github).toMatchObject({ status: "current", supersedes: forgejo.id, visibility: "space", scope: "space", rationale: "the team is there" });
    expect(forgejo).toMatchObject({ status: "superseded", superseded_by: github.id });
    expect((await earlierDecisionsFor("What did we use before GitHub?", copy)).map((item) => item.value)).toEqual(["Forgejo"]);
  });

  it("gives the private Skill a new id, its own Space and the same history", async () => {
    const { payInvoice } = await fullWork();
    const { copy } = await roundTrip();
    const [restored] = (await loadAllSkills()).filter((item) => item.space_id === copy);
    expect(restored.id).not.toBe(payInvoice.id);
    expect(restored).toMatchObject({ name: "Pay invoice", visibility: "space", runs: 5, successes: 4, failures: 1, lessons: payInvoice.lessons, created_at: payInvoice.created_at, instructions: payInvoice.instructions });
    expect(restored.provenance).toMatchObject({ origin: "saved", space_id: copy });
  });

  it("keeps a contradicted answer contradicted through /recall", async () => {
    await fullWork();
    const { copy } = await roundTrip();
    const [entry] = await loadTaskHistory(copy);
    const [episode] = episodes().filter((item) => item.space_id === copy);
    expect(entry.session_id).toBe(episode.session_id);
    expect(entry.session_id).not.toBe("task-1");
    const text = await recallCommand("Vendor A free plan", copy);
    expect(text).toContain(CONTRADICTED_ANSWER);
    expect(text).toContain("CONTRADICTED");
    expect(text).not.toContain(ANSWER);
  });

  it("keeps the whole task evidence: helpers, DAG nodes, edges, sources and the verdict, with new sessions", async () => {
    await fullWork();
    const [original] = episodes().filter((item) => item.space_id === WORK);
    const { copy } = await roundTrip();
    const [episode] = episodes().filter((item) => item.space_id === copy);
    expect(episode.id).toBe(original.id.replace("task-1", episode.session_id));
    const run = episode.dag_runs![0];
    expect(run.parent_session_id).toBe(episode.session_id);
    expect(run.action_id).toBe("action-1");
    const [research, verify] = run.nodes;
    expect(research).toMatchObject({ node_id: "research-1", status: "completed", mode: "read", checked_by: [{ node_id: "verify-1", status: "completed", verdict: "contradicted" }], trust: { sources: "observed", finding: "derived" } });
    expect(verify).toMatchObject({ node_id: "verify-1", depends_on: ["research-1"], verdict: "contradicted", trust: { verdict: "derived_verification" } });
    expect(verify.sources).toEqual(original.dag_runs![0].nodes[1].sources);
    expect(research.finding).toBe(original.dag_runs![0].nodes[0].finding);
    expect(research.child_session_id).toBe(`${episode.session_id}:worker:research-1`);
    expect(episode.delegations![0]).toMatchObject({ session_id: `${episode.session_id}:worker:0:abc`, parent_session_id: episode.session_id, mode: "read", trust: "observed" });
    expect(JSON.stringify(episode)).not.toContain("task-1");
  });

  it("is found again by normal search; the meaning index is not copied and rebuilds on its own", async () => {
    await fullWork();
    local[TASK_EPISODE_VECTOR_KEY] = [{ episode_id: episodes()[0].id, connection_id: "c", model: "m", dimensions: 3, content_hash: "h", indexed_at: "x", vector: [1, 0, 0] }];
    const { copy } = await roundTrip();
    const found = await searchTaskEpisodeMemory("Vendor A free plan", 5, copy);
    expect(found.map((item) => item.space_id)).toEqual([copy]);
    expect((local[TASK_EPISODE_VECTOR_KEY] as unknown[]).length).toBe(1);
  });

  it("brings schedules back paused, with new ids, in the new Space; existing ones keep running", async () => {
    await fullWork();
    const [original] = (await loadSchedules()).filter((item) => item.space_id === WORK);
    const { copy } = await roundTrip();
    const all = await loadSchedules();
    const [restored] = all.filter((item) => item.space_id === copy);
    expect(restored).toMatchObject({ enabled: false, task: "/pay-invoice-2 for this month", schedule: original.schedule, deliver_to: "telegram", created_at: original.created_at });
    expect(restored.id).not.toBe(original.id);
    expect(restored.next_run_at).toBeUndefined();
    expect(all.find((item) => item.id === original.id)?.enabled).toBe(true);
    expect(all).toHaveLength(3);
    await setScheduleEnabled(restored.id, true, new Date("2026-10-07T00:00:00"));
    expect((await loadSchedules()).find((item) => item.id === restored.id)?.next_run_at).toBeTruthy();
  });

  it("never pushes out a schedule to make room; what doesn't fit is counted", async () => {
    await fullWork();
    for (let index = (await loadSchedules()).length; index < MAX_SCHEDULES; index += 1) {
      await saveScheduledTask({ ...newScheduledTask(`job ${index}`, { kind: "interval", minutes: 60 }), space_id: OTHER });
    }
    const before = (await loadSchedules()).map((item) => item.id).sort();
    const { result, copy } = await roundTrip();
    expect(result.restored.schedules).toBe(0);
    expect(result.skipped.schedules_no_room).toBe(1);
    expect(result.warnings.join(" ")).toMatch(/scheduled task wasn't brought back/);
    expect((await loadSchedules()).map((item) => item.id).sort()).toEqual(before);
    expect(await spaceContents(copy)).toMatchObject({ schedules: 0, skills: 1 });
  });
});

describe("restored copies are independent", () => {
  it("restoring twice makes two copies that share no ids or sessions", async () => {
    await fullWork();
    const file = JSON.stringify(await backupSpace(WORK));
    const first = await restoreSpace(parseSpaceBackup(file)!);
    const second = await restoreSpace(parseSpaceBackup(file)!);
    if (!first.ok || !second.ok) throw new Error("restore failed");
    expect([first.space.name, second.space.name]).toEqual(["Work (2)", "Work (3)"]);
    const ids = (records: Array<{ id: string; space_id?: string }>) => records.map((item) => item.id);
    for (const records of [await loadAllSkills(), decisions(), episodes(), await loadSchedules()] as Array<Array<{ id: string }>>) {
      expect(new Set(ids(records)).size).toBe(records.length);
    }
    const sessions = episodes().flatMap((item) => [item.session_id, ...(item.dag_runs ?? []).flatMap((run) => run.nodes.map((node) => node.child_session_id ?? ""))]).filter(Boolean);
    expect(new Set(sessions).size).toBe(sessions.length);
    const slugs = (await loadAllSkills()).map((item) => item.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    // Each copy's history links only to its own episode.
    for (const copy of [first.space.id, second.space.id]) {
      const [entry] = await loadTaskHistory(copy);
      expect(episodes().find((item) => item.session_id === entry.session_id)?.space_id).toBe(copy);
      expect(await recallCommand("Vendor A free plan", copy)).toContain(CONTRADICTED_ANSWER);
    }
  });

  it("changing the copy never changes the original", async () => {
    const { payInvoice } = await fullWork();
    const { copy } = await roundTrip();
    const [copySkill] = (await loadAllSkills()).filter((item) => item.space_id === copy);
    await recordSkillRun(copySkill.id, "failed", "The button moved");
    await recordDecision({ subject: "Code home", value: "GitLab" }, copy);
    pinSpace(copy);
    const [fact] = (await loadAboutMe(copy)).filter((item) => item.text === "I prefer short answers");
    await updateFact(fact.id, "I prefer long answers");
    pinSpace(null);
    await saveChatMessages("chat-1", [{ id: "m1", role: "user", text: "Plan the vendor review" }, { id: "m2", role: "assistant", text: "Changed in the copy" }], copy);
    const original = (await loadAllSkills()).find((item) => item.id === payInvoice.id)!;
    expect(original).toMatchObject({ runs: 5, failures: 1, lessons: payInvoice.lessons });
    expect((await currentDecisions(WORK)).find((item) => item.subject === "Code home")?.value).toBe("GitHub");
    expect((await loadAboutMe(WORK)).map((item) => item.text)).toContain("I prefer short answers");
    expect((await loadChats(WORK))[0].messages).toHaveLength(1);
  });

  it("deleting the copy removes only its own records and schedules", async () => {
    await fullWork();
    const before = JSON.stringify([await backupSpace(WORK), await backupSpace(OTHER)]).replace(/"saved_at":"[^"]+"/g, "");
    const { copy } = await roundTrip();
    await deleteSpace(copy);
    const after = JSON.stringify([await backupSpace(WORK), await backupSpace(OTHER)]).replace(/"saved_at":"[^"]+"/g, "");
    expect(after).toBe(before);
    expect(await spaceContents(copy)).toMatchObject({ skills: 0, decisions: 0, episodes: 0, schedules: 0, chats: 0 });
    expect(await loadGlobalAboutMe()).toHaveLength(1);
    expect((await loadAllSkills()).map((item) => item.name).sort()).toEqual(["Check weather", "Home budget", "Old shared", "Pay invoice"]);
  });
});

describe("Skill commands", () => {
  it("the original keeps /pay-invoice; the copy takes /pay-invoice-2 and its schedule follows", async () => {
    const { payInvoice } = await fullWork();
    expect(payInvoice.slug).toBe("pay-invoice");
    const { result, copy } = await roundTrip();
    const [restored] = (await loadAllSkills()).filter((item) => item.space_id === copy);
    expect(restored.slug).toBe("pay-invoice-2");
    expect((await loadAllSkills()).find((item) => item.id === payInvoice.id)?.slug).toBe("pay-invoice");
    expect(result.renamed_commands).toEqual([{ from: "pay-invoice", to: "pay-invoice-2" }]);
    expect((await loadSchedules()).find((item) => item.space_id === copy)?.task).toBe("/pay-invoice-2 for this month");
  });

  it("keeps the command when nothing else uses it", async () => {
    await fullWork();
    const file = JSON.stringify(await backupSpace(WORK));
    await deleteSpace(WORK);
    const result = await restoreSpace(parseSpaceBackup(file)!);
    if (!result.ok) throw new Error(result.error);
    expect(result.space.name).toBe("Work");
    expect((await loadAllSkills()).find((item) => item.space_id === result.space.id)?.slug).toBe("pay-invoice");
    expect(result.renamed_commands).toEqual([]);
  });

  it("a Skill tagged with its Space before visibility was kept is backed up and comes back private", async () => {
    await spaces();
    local[SPACE_TAGGED_KEYS.skills] = [{ ...skill("Tagged early"), slug: "tagged-early", space_id: WORK }];
    expect((await loadSkills(WORK)).map((item) => item.name)).toEqual(["Tagged early"]);
    const { copy } = await roundTrip();
    const restored = (await loadAllSkills()).find((item) => item.space_id === copy);
    expect(restored).toMatchObject({ name: "Tagged early", visibility: "space", slug: "tagged-early-2" });
    expect(await loadSkills(OTHER)).toEqual([]);
  });

  it("a copied Skill's source follows a Skill in the backup and keeps one outside it", async () => {
    await spaces();
    const base = await saveSkill(skill("Base"), [], WORK);
    const outside = await saveSkill(skill("Outside"), [], OTHER);
    await saveSkill(skill("From base", { provenance: { origin: "copied", space_id: WORK, source_skill_id: base.id, source_space_id: "elsewhere" } }), [], WORK);
    await saveSkill(skill("From outside", { provenance: { origin: "copied", space_id: WORK, source_skill_id: outside.id, source_space_id: OTHER } }), [], WORK);
    const { copy } = await roundTrip();
    const restored = (await loadAllSkills()).filter((item) => item.space_id === copy);
    const newBase = restored.find((item) => item.name === "Base")!;
    expect(restored.find((item) => item.name === "From base")?.provenance).toMatchObject({ source_skill_id: newBase.id, source_space_id: "elsewhere", space_id: copy });
    expect(restored.find((item) => item.name === "From outside")?.provenance).toMatchObject({ source_skill_id: outside.id, source_space_id: OTHER });
  });
});

describe("full shelves", () => {
  it("a full decision shelf in one Space is never emptied by another Space", async () => {
    await spaces();
    const filler = (space: string, index: number): Decision => ({
      id: `${space}-${index}`,
      type: "decision",
      subject: `Subject ${index}`,
      value: "A",
      scope: "space",
      status: "current",
      created_at: "2026-01-01T00:00:00.000Z",
      space_id: space,
      visibility: "space",
      provenance: { by: "you", space_id: space, at: "2026-01-01T00:00:00.000Z" }
    });
    local[SPACE_TAGGED_KEYS.decisions] = [
      ...Array.from({ length: MAX_DECISIONS }, (_, index) => filler(OTHER, index)),
      ...Array.from({ length: MAX_DECISIONS }, (_, index) => ({ ...filler("global", index), id: `g-${index}`, scope: "global" as const, visibility: "all" as const }))
    ];
    // A new decision in Work, and a restore of Work, leave Home's and the every-Space decisions alone.
    await recordDecision({ subject: "Code home", value: "GitHub" }, WORK);
    await roundTrip();
    expect(decisions().filter((item) => item.space_id === OTHER)).toHaveLength(MAX_DECISIONS);
    expect(decisions().filter((item) => item.visibility === "all")).toHaveLength(MAX_DECISIONS);
    // A full Space only makes room from its own oldest.
    await recordDecision({ subject: "Another", value: "B" }, OTHER);
    const own = decisions().filter((item) => item.space_id === OTHER);
    expect(own).toHaveLength(MAX_DECISIONS);
    expect(own[0].subject).toBe("Another");
    expect(own.some((item) => item.id === `${OTHER}-${MAX_DECISIONS - 1}`)).toBe(false);
    expect(decisions().filter((item) => item.space_id === WORK)).toHaveLength(1);
  });

  it("a full episode shelf in another Space is never pushed out by a restore", async () => {
    await fullWork();
    const homeEpisode = episodes().find((item) => item.space_id === OTHER)!;
    local[TASK_EPISODE_MEMORY_KEY] = [...episodes(), ...Array.from({ length: MAX_EPISODES - 1 }, (_, index) => ({ ...homeEpisode, id: `home-${index}`, session_id: `home-${index}` }))];
    const before = episodes().filter((item) => item.space_id === OTHER).length;
    expect(before).toBe(MAX_EPISODES);
    await roundTrip();
    expect(episodes().filter((item) => item.space_id === OTHER)).toHaveLength(MAX_EPISODES);
  });

  it("full Skill shelves (another Space's and every Space's) are never pushed out by a restore", async () => {
    await fullWork();
    const now = "2026-01-01T00:00:00.000Z";
    local[SPACE_TAGGED_KEYS.skills] = [
      ...(local[SPACE_TAGGED_KEYS.skills] as UserSkill[]),
      ...Array.from({ length: MAX_SKILLS }, (_, index) => ({ ...skill(`home ${index}`), slug: `home-${index}`, created_at: now, space_id: OTHER, visibility: "space" as const })),
      ...Array.from({ length: MAX_SKILLS }, (_, index) => ({ ...skill(`all ${index}`), slug: `all-${index}`, created_at: now, space_id: WORK, visibility: "all" as const }))
    ];
    const count = async () => {
      const all = await loadAllSkills();
      return [all.filter((item) => item.space_id === OTHER && item.visibility === "space").length, all.filter((item) => item.visibility === "all").length];
    };
    const before = await count();
    await roundTrip();
    expect(await count()).toEqual(before);
  });
});

describe("restore safety", () => {
  async function crafted(data: SpaceBackupV2["data"]) {
    await spaces();
    const file: SpaceBackupV2 = {
      kind: "browserharness-space-backup",
      version: 2,
      saved_at: "2026-10-07T00:00:00.000Z",
      source_space: { id: "evil", name: "Crafted", color: "#000" },
      data,
      manifest: { counts: {} as never, left_out: [] }
    };
    const result = await restoreSpace(parseSpaceBackup(JSON.stringify(file))!);
    if (!result.ok) throw new Error(result.error);
    return result;
  }

  const bareEpisode = (session: string) => ({
    schema_version: 1,
    id: `episode:${session}:2026`,
    kind: "task_episode",
    recorded_at: "2026-10-07T00:00:00.000Z",
    session_id: session,
    title: "t",
    task: "check",
    status: "completed",
    start: { tab_id: 1, url: "https://a.example/", title: "A" },
    action_count: 1,
    manual_handoff_count: 0,
    tools: ["agent"],
    targets: [],
    sites: [],
    skill_refs: [],
    sensitive_payloads_removed: true,
    trust: "observed"
  });

  it("a file can never add something for every Space", async () => {
    const result = await crafted({
      scoped: {},
      tagged: {
        skills: [{ ...skill("Sneaky"), slug: "sneaky", visibility: "all" }, { ...skill("No space"), slug: "no-space" }],
        decisions: [
          { id: "d1", type: "decision", subject: "Bank", value: "Evil Bank", scope: "global", status: "current", visibility: "space", created_at: "2026-01-01T00:00:00.000Z" },
          { id: "d2", type: "decision", subject: "Shop", value: "Evil Shop", scope: "space", status: "current", visibility: "all", created_at: "2026-01-01T00:00:00.000Z" }
        ],
        episodes: []
      }
    });
    expect(result.skipped.every_space).toBe(4);
    expect(result.warnings.join(" ")).toMatch(/marked for every Space/);
    expect(await loadAllSkills()).toEqual([]);
    expect(decisions()).toEqual([]);
    for (const space of [WORK, OTHER, result.space.id]) {
      expect(await currentDecisions(space)).toEqual([]);
      expect(await loadSkills(space)).toEqual([]);
    }
  });

  it("checks secrets with today's rules and leaves ordinary content alone", async () => {
    const result = await crafted({
      scoped: {
        aboutMe: [
          { id: "f1", text: "My password is hunter22", source: "you", created_at: "2026-01-01T00:00:00.000Z" },
          { id: "f2", text: "I work on Order #123456 and Product ID B0C12345", source: "you", created_at: "2026-01-01T00:00:00.000Z" }
        ],
        instructions: "Answer briefly\nMy API key is sk-abcdefghijklmnopqrstuvwxyz123456",
        history: [
          { id: "h1", task: "Log in", result: "Done. The OTP was 482913.", timestamp: "2026-01-01T00:00:00.000Z", url: "https://site.example/cb?code=abc123secret&page=2" }
        ]
      },
      tagged: {
        decisions: [{ id: "d1", type: "decision", subject: "Admin password", value: "hunter22x", scope: "space", status: "current", visibility: "space", created_at: "2026-01-01T00:00:00.000Z" }],
        skills: [{ ...skill("Login", { instructions: "1. Open the site\n2. Type password hunter22secret\n3. Press Sign in" }), slug: "login", visibility: "space", space_id: "evil" }],
        episodes: []
      }
    });
    const copy = result.space.id;
    expect((await loadAboutMe(copy)).map((fact) => fact.text)).toEqual(["I work on Order #123456 and Product ID B0C12345"]);
    expect(await loadInstructions(copy)).toBe("Answer briefly");
    const [entry] = await loadTaskHistory(copy);
    expect(entry.result).not.toContain("482913");
    expect(entry.url).toBe("https://site.example/cb?page=2");
    expect(await currentDecisions(copy)).toEqual([]);
    const [login] = await loadSkills(copy);
    expect(login.instructions).not.toContain("hunter22secret");
    expect(login.instructions).toContain("Press Sign in");
    // The fact, the wish line, the decision and the Skill step.
    expect(result.skipped.secret).toBe(4);
  });

  it("keeps each episode site only in its cleaned form", async () => {
    const result = await crafted({
      scoped: {},
      tagged: {
        episodes: [
          {
            ...bareEpisode("s1"),
            sites: [
              "https://site.example/path?token=abc123secret&page=2",
              "https://site.example/path?session_id=deadbeef&page=2",
              "javascript:alert(1)",
              "https://shop.example/search?q=kettle&sort=price"
            ]
          }
        ]
      }
    });
    const [restored] = episodes().filter((item) => item.space_id === result.space.id);
    expect(restored.sites).toEqual(["https://site.example/path?page=2", "https://shop.example/search?q=kettle&sort=price"]);
    const json = JSON.stringify(restored);
    for (const bad of ["abc123secret", "deadbeef", "token=", "session_id=", "javascript:"]) expect(json).not.toContain(bad);
  });

  it("a helper or DAG inside an episode always belongs to the restored task, whatever the file says", async () => {
    const result = await crafted({
      scoped: {},
      tagged: {
        episodes: [
          {
            ...bareEpisode("original-parent"),
            delegations: [
              { action_id: "a2", worker_index: 0, task: "read", session_id: "original-parent:worker:0:x", status: "completed", sources: [], tools_used: [], parent_session_id: "fake-parent", trust: "observed", mode: "read" },
              { action_id: "a2", worker_index: 1, task: "read", session_id: "original-parent", status: "completed", sources: [], tools_used: [], parent_session_id: "original-parent" }
            ],
            dag_runs: [
              {
                action_id: "a1",
                parent_session_id: "another-fake-parent",
                nodes: [
                  { node_id: "r", type: "research", task: "find", status: "completed", mode: "read", child_session_id: "original-parent:worker:r", depends_on: [], sources: [], tools_used: [], trust: { sources: "observed" } },
                  { node_id: "v", type: "verify", task: "check", status: "blocked", mode: "read", depends_on: ["r"], blocked_by: "r", sources: [], tools_used: [], trust: { sources: "observed" } }
                ]
              }
            ]
          }
        ]
      }
    });
    const [restored] = episodes().filter((item) => item.space_id === result.space.id);
    const parent = restored.session_id;
    expect(parent).not.toBe("original-parent");
    expect(restored.delegations!.map((worker) => worker.parent_session_id)).toEqual([parent, parent]);
    expect(restored.dag_runs![0].parent_session_id).toBe(parent);
    const [first, second] = restored.delegations!;
    expect(first.session_id).toBe(`${parent}:worker:0:x`);
    expect(second.session_id).not.toBe(parent);
    const [r, v] = restored.dag_runs![0].nodes;
    expect(r.child_session_id).toBe(`${parent}:worker:r`);
    expect(v.child_session_id).toBeUndefined();
    expect(JSON.stringify(restored)).not.toMatch(/fake-parent|original-parent/);
  });

  it("never makes up who made a decision", async () => {
    const result = await crafted({
      scoped: {},
      tagged: {
        decisions: [
          { id: "d1", type: "decision", subject: "Deployment", value: "Cloudflare", scope: "space", status: "current", visibility: "space", created_at: "2026-01-01T00:00:00.000Z", provenance: null },
          { id: "d2", type: "decision", subject: "Hosting", value: "Vercel", scope: "space", status: "current", visibility: "space", created_at: "2026-01-01T00:00:00.000Z", provenance: { by: "you", at: "2026-01-01T00:00:00.000Z" } },
          { id: "d3", type: "decision", subject: "Code home", value: "GitHub", scope: "space", status: "current", visibility: "space", created_at: "2026-01-01T00:00:00.000Z", provenance: { by: "you", space_id: "evil", at: "2026-01-01T00:00:00.000Z" } }
        ]
      }
    });
    const restored = decisions().filter((item) => item.space_id === result.space.id);
    // Only the one whose provenance the file establishes; an older one without `origin` is fine.
    expect(restored.map((item) => item.value)).toEqual(["GitHub"]);
    expect(restored[0].provenance).toEqual({ by: "you", space_id: result.space.id, at: "2026-01-01T00:00:00.000Z" });
    expect(result.skipped.unreadable).toBe(2);
    expect(JSON.stringify(decisions())).not.toContain("Cloudflare");
  });

  it("counts secret steps and lessons left out of a Skill it still brings back", async () => {
    const result = await crafted({
      scoped: {},
      tagged: {
        skills: [
          {
            ...skill("Account", {
              instructions: "1. Open the account page\n2. Type password hunter22secret\n3. Press Submit",
              lessons: ["The Submit button is at the bottom", "The OTP is 482913"]
            }),
            slug: "account",
            visibility: "space",
            space_id: "evil"
          }
        ]
      }
    });
    const [restored] = await loadSkills(result.space.id);
    expect(restored.instructions).toContain("Open the account page");
    expect(restored.instructions).toContain("Press Submit");
    expect(restored.lessons).toEqual(["The Submit button is at the bottom"]);
    expect(JSON.stringify(restored)).not.toMatch(/hunter22secret|482913/);
    expect(result.skipped.secret).toBe(2);
    expect(result.warnings.join(" ")).toMatch(/2 things were left out because they looked like a password/);
  });

  it("never upgrades task evidence: verdicts only on finished verifiers, fixed trust labels, read-only helpers", async () => {
    const episode = {
      schema_version: 1,
      id: "episode:s1:2026",
      kind: "task_episode",
      recorded_at: "2026-10-07T00:00:00.000Z",
      session_id: "s1",
      title: "t",
      task: "check",
      status: "completed",
      start: { tab_id: 1, url: "https://a.example/?token=abcdef123456", title: "A" },
      action_count: 1,
      manual_handoff_count: 0,
      tools: ["agent"],
      targets: [],
      sites: [],
      skill_refs: [],
      sensitive_payloads_removed: true,
      trust: "observed",
      dag_runs: [
        {
          action_id: "a1",
          parent_session_id: "s1",
          nodes: [
            { node_id: "r", type: "research", task: "find", status: "completed", mode: "act", depends_on: [], sources: [], tools_used: [], verdict: "supported", trust: { sources: "user" } },
            { node_id: "v", type: "verify", task: "check", status: "failed", mode: "read", depends_on: ["r"], sources: [], tools_used: [], verdict: "supported", trust: {} },
            { node_id: "w", type: "verify", task: "check", status: "completed", mode: "read", depends_on: ["r", "ghost"], sources: [], tools_used: [], verdict: "certain", trust: {} }
          ]
        }
      ]
    };
    const result = await crafted({ scoped: {}, tagged: { episodes: [episode] } });
    const [restored] = episodes().filter((item) => item.space_id === result.space.id);
    const [r, v, w] = restored.dag_runs![0].nodes;
    expect(r).toMatchObject({ mode: "read", trust: { sources: "observed" } });
    expect(r.verdict).toBeUndefined();
    expect(v.verdict).toBeUndefined();
    expect(w).toMatchObject({ verdict: "insufficient", depends_on: ["r"] });
    expect(r.checked_by).toEqual([{ node_id: "v", status: "failed" }, { node_id: "w", status: "completed", verdict: "insufficient" }]);
    expect(r.child_session_id).toBeUndefined();
    expect(restored.start.url).toBe("https://a.example/");
    expect(restored.dag_runs![0]).toMatchObject({ completed_count: 2, failed_count: 1 });
  });

  it("rejects files that aren't backups", () => {
    expect(parseSpaceBackup("{}")).toBeNull();
    expect(parseSpaceBackup("nope")).toBeNull();
    expect(parseSpaceBackup(JSON.stringify({ kind: "browserharness-space-backup", version: 3, data: {} }))).toBeNull();
    expect(parseSpaceBackup(JSON.stringify({ kind: "browserharness-space-backup", version: 2, data: {}, source_space: { name: "x" } }))).toBeNull();
  });

  it("a failed write leaves no half-restored Space behind", async () => {
    await fullWork();
    const before = structuredClone(local);
    const file = JSON.stringify(await backupSpace(WORK));
    failNextSet = true;
    const result = await restoreSpace(parseSpaceBackup(file)!);
    expect(result.ok).toBe(false);
    expect((await loadSpaces()).spaces.map((space) => space.name)).toEqual(["Personal", "Work", "Home"]);
    expect(local).toEqual(before);
  });
});

describe("older backups", () => {
  it("a version 1 file still comes back with what it holds", async () => {
    const v1 = {
      kind: "browserharness-space-backup",
      version: 1,
      saved_at: "2026-09-01T00:00:00.000Z",
      space: { name: "Trip", color: "#16a34a" },
      data: {
        chats: [{ id: "c1", title: "Goa plans", created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z", messages: [{ id: "m", role: "user", text: "Beaches in Goa" }] }],
        aboutMe: [{ id: "f1", text: "I like quiet beaches", source: "you", created_at: "2026-09-01T00:00:00.000Z" }],
        instructions: "Keep it short",
        history: [{ id: "h1", task: "Find beaches", result: "Palolem", timestamp: "2026-09-01T00:00:00.000Z", session_id: "gone" }]
      }
    };
    const parsed = parseSpaceBackup(JSON.stringify(v1));
    expect(parsed?.version).toBe(1);
    const result = await restoreSpace(parsed!);
    if (!result.ok) throw new Error(result.error);
    expect(result.space).toMatchObject({ name: "Trip", color: "#16a34a" });
    expect(result.restored).toMatchObject({ chats: 1, facts: 1, instructions: true, history: 1, skills: 0, decisions: 0, episodes: 0, schedules: 0 });
    expect((await loadChats(result.space.id))[0].title).toBe("Goa plans");
    expect(await loadInstructions(result.space.id)).toBe("Keep it short");
    // An answer whose task isn't in the file links to nothing.
    expect((await loadTaskHistory(result.space.id))[0].session_id).toBeUndefined();
  });
});

describe("deleting a Space", () => {
  it("removes its schedules too, so none runs for a Space that is gone", async () => {
    await fullWork();
    await deleteSpace(WORK);
    expect((await loadSchedules()).map((item) => item.space_id)).toEqual([OTHER]);
  });

  it("emptying the first Space removes its own schedules and keeps ones that name no Space", async () => {
    await saveScheduledTask(newScheduledTask("personal job", { kind: "interval", minutes: 60 }));
    local[SCHEDULES_KEY] = [...(local[SCHEDULES_KEY] as unknown[]), { ...newScheduledTask("old job", { kind: "interval", minutes: 60 }) }];
    await deleteSpace(DEFAULT_SPACE_ID);
    expect((await loadSchedules()).map((item) => item.task)).toEqual(["old job"]);
  });
});

describe("size and speed", () => {
  it("handles a busy Space quickly", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T00:00:00.000Z"));
    await fullWork();
    let tick = 0;
    for (let index = 0; index < 199; index += 1) {
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 7, 0, 0, ++tick)));
      await contradictedTask(`bulk-${index}`, WORK);
    }
    for (let index = 0; index < 250; index += 1) await saveChatMessages(`bulk-chat-${index}`, [{ id: "m", role: "user", text: `Question ${index} about vendors and prices` }, { id: "a", role: "assistant", text: "An answer ".repeat(40) }], WORK);
    for (let index = 0; index < 60; index += 1) await addFacts([`My favourite thing number ${index} is item ${index}`], "you", WORK);
    for (let index = 0; index < 40; index += 1) await recordDecision({ subject: `Choice ${index}`, value: `Option ${index}` }, WORK);
    for (let index = 0; index < 20; index += 1) await saveSkill(skill(`Skill ${index}`), [], WORK);
    vi.useRealTimers();

    let started = performance.now();
    const backup = await backupSpace(WORK);
    const backupMs = performance.now() - started;
    const text = JSON.stringify(backup);
    started = performance.now();
    const result = await restoreSpace(parseSpaceBackup(text)!);
    const restoreMs = performance.now() - started;
    if (!result.ok) throw new Error(result.error);
    expect(result.restored).toMatchObject({ chats: 251, history: 200, episodes: 200, skills: 21, decisions: 41 });
    expect(result.restored.facts).toBe(60);
    console.log(
      `[phase9 perf] backup ${backupMs.toFixed(1)} ms, ${(text.length / 1024).toFixed(0)} KB (${backup.manifest.counts.episodes} episodes, ${backup.manifest.counts.chats} chats, ${backup.manifest.counts.history} history); restore ${restoreMs.toFixed(1)} ms (prepare ${result.timings.prepare_ms} ms, write ${result.timings.write_ms} ms)`
    );
    expect(backupMs).toBeLessThan(2000);
    expect(restoreMs).toBeLessThan(4000);
  });
});
