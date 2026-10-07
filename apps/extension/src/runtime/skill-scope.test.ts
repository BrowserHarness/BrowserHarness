// Memory v2, Phase 7: a Skill stays in the Space it was made in unless the
// person shares it. Sharing one Skill with every Space and copying it into
// another Space are different things: one shared Skill versus two.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSpace, deleteSpace, DEFAULT_SPACE_ID, pinSpace, switchSpace } from "./spaces";
import {
  copySkillToSpace,
  deleteSkill,
  loadAllSkills,
  loadSkills,
  MAX_SKILLS,
  parseSkillMd,
  recordSkillRun,
  saveSkill,
  setSkillReach,
  skillFromRecording,
  skillFromSession,
  SKILLS_STORAGE_KEY,
  type UserSkill
} from "./skills";
import { addRefinementToSharedSkill, applyLearningPlan, keepRefinementInSpace, matchSkill, planLearning } from "./skill-learning";
import { parseSlashCommand } from "./slash-commands";
import { localMemorySource } from "./context/memory-source";
import type { BrowserTaskSessionEvidence } from "./session-evidence";
import type { SavedWorkflow } from "./workflows";

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
});

function skill(name: string, extra: Partial<UserSkill> = {}): UserSkill {
  return {
    id: crypto.randomUUID(),
    name,
    slug: "",
    description: name,
    instructions: "1. Open the expenses page\n2. Fill the form\n3. Press Submit",
    source: "chat",
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    runs: 0,
    successes: 0,
    failures: 0,
    lessons: [],
    ...extra
  };
}

function evidence(task: string, steps = ["Expenses", "Amount", "Submit", "Done"]): BrowserTaskSessionEvidence {
  return {
    version: 1,
    session_id: crypto.randomUUID(),
    title: task,
    task,
    started_at: "2026-10-06T10:00:00.000Z",
    status: "completed",
    start: { tab_id: 1, url: "https://expenses.example", title: task },
    actions: steps.map((name, index) => ({
      id: `a${index}`,
      ordinal: index + 1,
      tool: "click",
      input: {},
      target: { accessible_name: name, role: "button" },
      at: "2026-10-06T10:00:01.000Z"
    })),
    final_url: "https://expenses.example/done"
  } as unknown as BrowserTaskSessionEvidence;
}

async function spaces() {
  const a = await createSpace("Acme", { switchTo: false });
  const b = await createSpace("Home", { switchTo: false });
  if (!a.ok || !b.ok) throw new Error("spaces");
  return { A: a.space.id, B: b.space.id };
}

const names = (skills: UserSkill[]) => skills.map((item) => item.name);

describe("every way a Skill is made keeps it in the Space it was made in", () => {
  it("1. a Skill learned on its own belongs to Space A and is not seen in B", async () => {
    const { A, B } = await spaces();
    const plan = planLearning({ task: "Submit expense report", status: "completed", message: "Done", evidence: evidence("Submit expense report"), autoSkills: true });
    const { saved } = await applyLearningPlan(plan, [], A);
    expect(saved).toMatchObject({ space_id: A, visibility: "space", provenance: { origin: "learned", space_id: A } });
    expect(names(await loadSkills(A))).toHaveLength(1);
    expect(await loadSkills(B)).toEqual([]);
    expect(await loadSkills(DEFAULT_SPACE_ID)).toEqual([]);
  });

  it("2. Save as Skill keeps it in the current Space", async () => {
    const { A, B } = await spaces();
    await switchSpace(A);
    const saved = await saveSkill(skillFromSession(evidence("Submit expense report")));
    expect(saved).toMatchObject({ space_id: A, visibility: "space", provenance: { origin: "saved" } });
    expect(await loadSkills(B)).toEqual([]);
  });

  it("3. an imported SKILL.md (file or link) goes to the current Space unless shared on purpose", async () => {
    const { A, B } = await spaces();
    const parsed = parseSkillMd("---\nname: weekly-report\ndescription: Make the weekly report\n---\n# Weekly report\n\nOpen the sheet.");
    if (!parsed.ok) throw new Error(parsed.error);
    const saved = await saveSkill(parsed.skill, [], A);
    expect(saved).toMatchObject({ space_id: A, visibility: "space", provenance: { origin: "imported" } });
    expect(await loadSkills(B)).toEqual([]);
    await setSkillReach(saved.id, "every-space", A);
    expect(names(await loadSkills(B))).toEqual(["Weekly report"]);
  });

  it("4. a Skill made from a recording belongs to the Space it was made in, though recordings are shared", async () => {
    const { A, B } = await spaces();
    const workflow = { id: "w1", name: "File expense", url: "https://expenses.example", created_at: "2026-10-01T00:00:00.000Z", steps: [] } as unknown as SavedWorkflow;
    const saved = await saveSkill(skillFromRecording(workflow), [], A);
    expect(saved).toMatchObject({ space_id: A, provenance: { origin: "recording" } });
    expect(await loadSkills(B)).toEqual([]);
  });

  it("keeping a learned Skill doesn't change where it came from", async () => {
    const { A } = await spaces();
    const learned = await saveSkill(skill("Learned", { source: "auto" }), [], A);
    const kept = await saveSkill({ ...learned, source: "chat" }, [], A);
    expect(kept.provenance?.origin).toBe("learned");
  });
});

describe("sharing with every Space is the same Skill; copying makes another", () => {
  it("5. making a Skill available in every Space keeps its id, words, lessons, counts and origin", async () => {
    const { A, B } = await spaces();
    const saved = await saveSkill(skill("Submit expense report", { lessons: ["Wait for the receipt upload"], runs: 4, successes: 3, failures: 1 }), [], A);
    const shared = await setSkillReach(saved.id, "every-space", A);
    expect(shared).toMatchObject({
      id: saved.id,
      name: saved.name,
      slug: saved.slug,
      instructions: saved.instructions,
      lessons: ["Wait for the receipt upload"],
      runs: 4,
      successes: 3,
      failures: 1,
      created_at: saved.created_at,
      provenance: saved.provenance,
      visibility: "all"
    });
    expect((await loadSkills(B)).map((item) => item.id)).toEqual([saved.id]);
    expect(await loadAllSkills()).toHaveLength(1);
  });

  it("only a Space's own Skill can be shared from it, never another Space's", async () => {
    const { A, B } = await spaces();
    const saved = await saveSkill(skill("Private"), [], A);
    expect(await setSkillReach(saved.id, "every-space", B)).toBeNull();
    expect(await loadSkills(B)).toEqual([]);
  });

  it("6. 'only this Space' keeps the shared Skill's history and hides it from other Spaces", async () => {
    const { A, B } = await spaces();
    const saved = await saveSkill(skill("Submit expense report", { visibility: "all", lessons: ["Use the new form"], runs: 2, successes: 2 }), [], A);
    const moved = await setSkillReach(saved.id, "this-space", B);
    expect(moved).toMatchObject({ id: saved.id, visibility: "space", space_id: B, lessons: ["Use the new form"], runs: 2, successes: 2 });
    expect((await loadSkills(B)).map((item) => item.id)).toEqual([saved.id]);
    expect(await loadSkills(A)).toEqual([]);
    expect(await loadSkills(DEFAULT_SPACE_ID)).toEqual([]);
  });

  it("7. a copy from A to B is a new Skill with its own id, fresh counts and a note of where it came from", async () => {
    const { A, B } = await spaces();
    const original = await saveSkill(skill("Submit expense report", { lessons: ["Wait for the upload"], runs: 9, successes: 7, failures: 2, last_run_at: "2026-10-05T00:00:00.000Z" }), [], A);
    const copy = await copySkillToSpace(original.id, B, A);
    expect(copy).toMatchObject({
      name: original.name,
      description: original.description,
      instructions: original.instructions,
      lessons: ["Wait for the upload"],
      runs: 0,
      successes: 0,
      failures: 0,
      space_id: B,
      visibility: "space",
      provenance: { origin: "copied", source_skill_id: original.id, source_space_id: A, space_id: B }
    });
    expect(copy?.id).not.toBe(original.id);
    expect(copy?.provenance?.copied_at).toBeTruthy();
    expect(copy).not.toHaveProperty("last_run_at");
    expect((await loadSkills(A)).map((item) => item.id)).toEqual([original.id]);
    expect((await loadSkills(B)).map((item) => item.id)).toEqual([copy!.id]);
  });

  it("a Space's own Skill can't be copied into the same Space, or into a Space that doesn't exist", async () => {
    const { A } = await spaces();
    const original = await saveSkill(skill("Private"), [], A);
    expect(await copySkillToSpace(original.id, A, A)).toBeNull();
    expect(await copySkillToSpace(original.id, "no-such-space", A)).toBeNull();
    expect(await loadAllSkills()).toHaveLength(1);
  });

  it("8. improving, running or renaming the copy never changes the original, and the other way round", async () => {
    const { A, B } = await spaces();
    const original = await saveSkill(skill("Submit expense report"), [], A);
    const copy = (await copySkillToSpace(original.id, B, A))!;
    await saveSkill({ ...copy, name: "Home expenses", instructions: "1. Use the new expenses app" }, [], B);
    await recordSkillRun(copy.id, "failed", "The new app needs a project code");
    const [a] = await loadSkills(A);
    expect(a).toMatchObject({ name: "Submit expense report", instructions: original.instructions, lessons: [], runs: 0 });
    await recordSkillRun(original.id, "worked");
    const [b] = await loadSkills(B);
    expect(b).toMatchObject({ name: "Home expenses", instructions: "1. Use the new expenses app", lessons: ["The new app needs a project code"], runs: 1, successes: 0, failures: 1 });
  });
});

describe("Skills saved before Skills had a Space", () => {
  it("9. stay available in every Space, read as an every-Space Skill marked legacy, with no invented Space or origin details", async () => {
    const { A, B } = await spaces();
    store[SKILLS_STORAGE_KEY] = [{ ...skill("Old helper"), slug: "old-helper" }];
    for (const space of [A, B, DEFAULT_SPACE_ID]) {
      expect((await loadSkills(space)).map((item) => item.slug)).toEqual(["old-helper"]);
    }
    const [old] = await loadAllSkills();
    expect(old).toMatchObject({ visibility: "all", legacy: true, provenance: { origin: "legacy" } });
    expect(old).not.toHaveProperty("space_id");
    expect(old.provenance).toEqual({ origin: "legacy" });
    // Kept that way when it is saved again, and deleting a Space never removes it.
    await saveSkill({ ...old, name: "Old helper renamed" }, [], A);
    await deleteSpace(A);
    expect((await loadSkills(B)).map((item) => item.name)).toEqual(["Old helper renamed"]);
    // Moving it into one Space is the person's choice; its origin stays legacy.
    const moved = await setSkillReach(old.id, "this-space", B);
    expect(moved).toMatchObject({ visibility: "space", space_id: B, provenance: { origin: "legacy" } });
    expect(moved).not.toHaveProperty("legacy");
    expect(await loadSkills(DEFAULT_SPACE_ID)).toEqual([]);
  });

  it("Skills from Phase 2 to 6 (with a Space but no origin) are not given one", async () => {
    const { A } = await spaces();
    store[SKILLS_STORAGE_KEY] = [{ ...skill("Phase 2 skill"), slug: "phase-2-skill", space_id: A, visibility: "space" }];
    const [found] = await loadSkills(A);
    expect(found).not.toHaveProperty("provenance");
    expect(found).not.toHaveProperty("legacy");
  });
});

describe("matching only looks at Skills the Space may use", () => {
  it("10. a perfect match kept privately in another Space is never considered", async () => {
    const { A, B } = await spaces();
    await saveSkill(skill("Submit expense report"), [], A);
    expect(matchSkill("submit expense report", await loadSkills(B))).toBeNull();
    const found = await localMemorySource.relevantSkills("submit expense report", B, 3);
    expect(found.skills).toEqual([]);
    expect(found.walled).toBe(1);
    expect(parseSlashCommand("/submit-expense-report", await loadSkills(B)).kind).toBe("unknown");
  });

  it("11. this Space's own Skill wins over an every-Space Skill that fits equally well; neither is deleted", async () => {
    const { A, B } = await spaces();
    const shared = await saveSkill(skill("Submit expense report", { visibility: "all" }), [], B);
    const own = await saveSkill(skill("Submit expense report"), [], A);
    for (const order of [await loadSkills(A), [...(await loadSkills(A))].reverse()]) {
      expect(matchSkill("submit expense report", order)?.skill.id).toBe(own.id);
    }
    expect((await localMemorySource.relevantSkills("submit expense report", A, 1)).skills[0].skill.id).toBe(own.id);
    // In a Space without its own, the shared one is used.
    expect((await localMemorySource.relevantSkills("submit expense report", DEFAULT_SPACE_ID, 1)).skills[0].skill.id).toBe(shared.id);
    expect(await loadAllSkills()).toHaveLength(2);
  });

  it("a better-fitting every-Space Skill still wins over a weaker own one", async () => {
    const { A } = await spaces();
    const shared = await saveSkill(skill("Submit expense report", { visibility: "all" }), [], A);
    await saveSkill(skill("Submit expense report for travel claims abroad"), [], A);
    expect(matchSkill("submit expense report", await loadSkills(A))?.skill.id).toBe(shared.id);
  });
});

describe("deleting", () => {
  it("12. deleting Space A removes only A's own Skills: every-Space Skills and other Spaces' copies stay", async () => {
    const { A, B } = await spaces();
    const own = await saveSkill(skill("A only"), [], A);
    await saveSkill(skill("Shared from A", { visibility: "all" }), [], A);
    await saveSkill(skill("B only"), [], B);
    await copySkillToSpace(own.id, B, A);
    await deleteSpace(A);
    expect(names(await loadAllSkills()).sort()).toEqual(["A only", "B only", "Shared from A"]);
    expect(names(await loadSkills(B)).sort()).toEqual(["A only", "B only", "Shared from A"]);
    expect((await loadAllSkills()).find((item) => item.name === "A only")?.space_id).toBe(B);
  });

  it("13. deleting the original leaves its copies; deleting a shared Skill removes that one Skill only", async () => {
    const { A, B } = await spaces();
    const original = await saveSkill(skill("Submit expense report"), [], A);
    const copy = (await copySkillToSpace(original.id, B, A))!;
    await deleteSkill(original.id, A);
    expect((await loadSkills(B)).map((item) => item.id)).toEqual([copy.id]);
    const shared = await saveSkill(skill("Shared", { visibility: "all" }), [], A);
    await deleteSkill(shared.id, B);
    expect((await loadAllSkills()).map((item) => item.id)).toEqual([copy.id]);
  });
});

describe("a shared Skill doesn't pick up one Space's details on its own", () => {
  const shared = async (A: string) =>
    saveSkill(skill("Submit expense report", { visibility: "all", runs: 1, successes: 1, lessons: ["Attach the receipt first"] }), [], A);

  it("14. a lesson from a run in Acme is held, not added for every Space; the run is still counted", async () => {
    const { A, B } = await spaces();
    const global = await shared(A);
    const plan = planLearning({ task: "Submit expense report", status: "stopped", message: "The form needs department code FIN-44", used: global, autoSkills: true });
    const { held } = await applyLearningPlan(plan, [], A);
    expect(held).toMatchObject({ skillId: global.id, spaceId: A, lesson: "The form needs department code FIN-44" });
    const [inB] = await loadSkills(B);
    expect(inB.lessons).toEqual(["Attach the receipt first"]);
    expect(JSON.stringify(await loadSkills(B))).not.toContain("FIN-44");
    expect(inB).toMatchObject({ runs: 2, successes: 1, failures: 1 });

    // Kept for this Space only: a copy in Acme carries it; the shared Skill and Home never see it.
    const kept = await keepRefinementInSpace(held!);
    if (!kept.ok) throw new Error(kept.reason);
    const copy = kept.skill;
    expect(copy).toMatchObject({ space_id: A, provenance: { origin: "copied", source_skill_id: global.id }, lessons: ["The form needs department code FIN-44", "Attach the receipt first"] });
    expect(JSON.stringify(await loadSkills(B))).not.toContain("FIN-44");
    // From now on Acme's own copy wins the match in Acme.
    expect(matchSkill("submit expense report", await loadSkills(A))?.skill.id).toBe(copy.id);
  });

  it("a shorter way found in one Space is held too; the person can add it for every Space", async () => {
    const { A, B } = await spaces();
    const global = await shared(A);
    const plan = planLearning({ task: "Submit expense report", status: "completed", message: "Done", evidence: evidence("Submit expense report", ["Quick submit", "Done"]), used: { ...global, instructions: "1. a\n2. b\n3. c\n4. d" }, autoSkills: true });
    expect(plan.kind).toBe("improve");
    const { saved, held } = await applyLearningPlan(plan, [], A);
    expect(saved).toBeNull();
    expect(held?.improved?.instructions).toContain("Quick submit");
    const [unchanged] = await loadSkills(B);
    expect(unchanged.instructions).toBe(global.instructions);
    expect(unchanged.runs).toBe(2);
    // The person chose "Add it for every Space".
    expect((await addRefinementToSharedSkill(held!)).ok).toBe(true);
    const [changed] = await loadSkills(B);
    expect(changed).toMatchObject({ id: global.id, visibility: "all", runs: 2 });
    expect(changed.instructions).toContain("Quick submit");
  });

  it("a Space's own Skill still learns lessons and shorter ways on its own, as before", async () => {
    const { A } = await spaces();
    const own = await saveSkill(skill("Submit expense report"), [], A);
    const plan = planLearning({ task: "Submit expense report", status: "stopped", message: "The form needs department code FIN-44", used: own, autoSkills: true });
    const { held } = await applyLearningPlan(plan, [], A);
    expect(held).toBeUndefined();
    expect((await loadSkills(A))[0].lessons).toEqual(["The form needs department code FIN-44"]);
  });
});

describe("room for Skills", () => {
  it("one busy Space never pushes out another Space's Skills or the every-Space ones", async () => {
    const { A, B } = await spaces();
    await saveSkill(skill("Home skill", { created_at: "2026-01-01T00:00:00.000Z" }), [], B);
    await saveSkill(skill("Shared skill", { visibility: "all" }), [], B);
    const many = Array.from({ length: MAX_SKILLS + 5 }, (_, index) => ({ ...skill(`Acme ${index}`), slug: `acme-${index}`, space_id: A, visibility: "space" as const }));
    store[SKILLS_STORAGE_KEY] = [...many, ...(store[SKILLS_STORAGE_KEY] as UserSkill[])];
    await saveSkill(skill("One more Acme"), [], A);
    expect(names(await loadSkills(B)).sort()).toEqual(["Home skill", "Shared skill"]);
    expect((await loadAllSkills()).filter((item) => item.space_id === A && item.visibility === "space")).toHaveLength(MAX_SKILLS);
  }, 20_000);
});

describe("15. every entry point looks Skills up in the task's own Space", () => {
  it("the context for a task in Home, started while Acme is in use, sees Home's and shared Skills only", async () => {
    const { A, B } = await spaces();
    await saveSkill(skill("Submit expense report"), [], A);
    const shared = await saveSkill(skill("Submit expense report", { visibility: "all" }), [], B);
    await switchSpace(A);
    // Side panel, scheduled and phone tasks, and the agent's skills tool all call loadSkills/relevantSkills with the task's Space.
    expect((await loadSkills(B)).map((item) => item.id)).toEqual([shared.id]);
    expect((await localMemorySource.relevantSkills("submit expense report", B, 1)).skills[0].skill.id).toBe(shared.id);
    const command = parseSlashCommand("/submit-expense-report", await loadSkills(B));
    expect(command.kind).toBe("unknown");
    // A lesson from a run in Home goes to Home's choice, not to Acme in use now.
    const { held } = await applyLearningPlan({ kind: "lesson", skillId: shared.id, lesson: "Home needs a household code" }, [], B);
    expect(held?.spaceId).toBe(B);
  });
});

describe("performance", () => {
  it("filtering and matching stay quick with full shelves in several Spaces", async () => {
    const { A, B } = await spaces();
    store[SKILLS_STORAGE_KEY] = [A, B, DEFAULT_SPACE_ID].flatMap((space) =>
      Array.from({ length: MAX_SKILLS }, (_, index) => ({ ...skill(`Task ${space} ${index} report`), slug: `t-${space}-${index}`, space_id: space, visibility: "space" as const }))
    );
    const started = performance.now();
    const visible = await loadSkills(A);
    matchSkill("task report", visible);
    await localMemorySource.relevantSkills("task report", A, 1);
    expect(visible).toHaveLength(MAX_SKILLS);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("review fixes", () => {
  it("a copy of a shared Skill records where the Skill was made, not the Space it was viewed from", async () => {
    const { A, B } = await spaces();
    const c = await createSpace("Client", { switchTo: false });
    if (!c.ok) throw new Error("space");
    const C = c.space.id;
    const original = await saveSkill(skill("Submit expense report"), [], A);
    await setSkillReach(original.id, "every-space", A);
    await switchSpace(B);
    const copy = await copySkillToSpace(original.id, C, B);
    expect(copy).toMatchObject({ space_id: C, provenance: { origin: "copied", space_id: C, source_skill_id: original.id, source_space_id: A } });
  });

  it("a copy of a legacy Skill names the Skill it came from but no source Space, since nobody knows it", async () => {
    const { B } = await spaces();
    const c = await createSpace("Client", { switchTo: false });
    if (!c.ok) throw new Error("space");
    store[SKILLS_STORAGE_KEY] = [{ ...skill("Old helper"), slug: "old-helper", id: "legacy-1" }];
    const copy = await copySkillToSpace("legacy-1", c.space.id, B);
    expect(copy?.provenance).toMatchObject({ origin: "copied", source_skill_id: "legacy-1", space_id: c.space.id });
    expect(copy?.provenance).not.toHaveProperty("source_space_id");
  });

  it("sharing into a full every-Space shelf keeps the shared Skill; the oldest shared one makes room; other shelves untouched", async () => {
    const { A, B } = await spaces();
    const shared = Array.from({ length: MAX_SKILLS }, (_, index) => ({ ...skill(`Shared ${index}`), slug: `shared-${index}`, space_id: B, visibility: "all" as const }));
    const homeOwn = { ...skill("Home own"), slug: "home-own", space_id: B, visibility: "space" as const };
    const acmeOther = { ...skill("Acme other"), slug: "acme-other", space_id: A, visibility: "space" as const };
    const mover = { ...skill("Acme old", { lessons: ["x"], runs: 5, successes: 4, failures: 1 }), slug: "acme-old", space_id: A, visibility: "space" as const, provenance: { origin: "saved" as const } };
    // The Skill to share sits at the very end of the store, behind a full shelf of shared Skills.
    store[SKILLS_STORAGE_KEY] = [...shared, homeOwn, acmeOther, mover];
    const promoted = await setSkillReach(mover.id, "every-space", A);
    const all = await loadAllSkills();
    const kept = all.find((item) => item.id === mover.id);
    expect(promoted).not.toBeNull();
    expect(kept).toMatchObject({ visibility: "all", instructions: mover.instructions, lessons: ["x"], runs: 5, successes: 4, failures: 1, created_at: mover.created_at, provenance: { origin: "saved" } });
    expect(all.filter((item) => item.visibility === "all")).toHaveLength(MAX_SKILLS);
    expect(all.some((item) => item.slug === `shared-${MAX_SKILLS - 1}`)).toBe(false);
    expect(all.some((item) => item.slug === "shared-0")).toBe(true);
    expect(names(all.filter((item) => item.visibility === "space")).sort()).toEqual(["Acme other", "Home own"]);
  });

  it("moving a shared Skill into a full Space keeps it there; that Space's oldest makes room; other shelves untouched", async () => {
    const { A, B } = await spaces();
    const full = Array.from({ length: MAX_SKILLS }, (_, index) => ({ ...skill(`Home ${index}`), slug: `home-${index}`, space_id: B, visibility: "space" as const }));
    const otherShared = { ...skill("Other shared"), slug: "other-shared", space_id: A, visibility: "all" as const };
    const acme = { ...skill("Acme own"), slug: "acme-own", space_id: A, visibility: "space" as const };
    const mover = { ...skill("Shared mover", { runs: 3, successes: 3 }), slug: "shared-mover", space_id: A, visibility: "all" as const };
    store[SKILLS_STORAGE_KEY] = [...full, otherShared, acme, mover];
    const demoted = await setSkillReach(mover.id, "this-space", B);
    const all = await loadAllSkills();
    expect(demoted).toMatchObject({ id: mover.id, visibility: "space", space_id: B });
    expect(all.find((item) => item.id === mover.id)).toMatchObject({ visibility: "space", space_id: B, runs: 3, successes: 3 });
    expect(all.filter((item) => item.space_id === B && item.visibility === "space")).toHaveLength(MAX_SKILLS);
    expect(all.some((item) => item.slug === `home-${MAX_SKILLS - 1}`)).toBe(false);
    expect(names(all.filter((item) => item.space_id === A)).sort()).toEqual(["Acme own", "Other shared"]);
  });

  it("legacy Skills saved back to the store never gain an invented Space", async () => {
    const { A } = await spaces();
    store[SKILLS_STORAGE_KEY] = [{ ...skill("Old helper"), slug: "old-helper", id: "legacy-1" }];
    // Any later write of the store (here, saving another Skill) persists the read-time legacy marks.
    await saveSkill(skill("New one"), [], A);
    const stored = (store[SKILLS_STORAGE_KEY] as UserSkill[]).find((item) => item.id === "legacy-1");
    expect(stored).toMatchObject({ visibility: "all", legacy: true, provenance: { origin: "legacy" } });
    expect(stored).not.toHaveProperty("space_id");
    expect(stored?.provenance).toEqual({ origin: "legacy" });
    expect((await loadSkills(A)).some((item) => item.id === "legacy-1")).toBe(true);
  });

  it("a held lesson isn't applied 'for every Space' once the Skill was made private or deleted meanwhile", async () => {
    const { A, B } = await spaces();
    const global = await saveSkill(skill("Submit expense report", { visibility: "all" }), [], A);
    const { held } = await applyLearningPlan({ kind: "lesson", skillId: global.id, lesson: "Needs FIN-44" }, [], A);
    await setSkillReach(global.id, "this-space", B);
    expect(await addRefinementToSharedSkill(held!)).toEqual({ ok: false, reason: "changed" });
    expect(await keepRefinementInSpace(held!)).toEqual({ ok: false, reason: "changed" });
    expect(JSON.stringify(await loadAllSkills())).not.toContain("FIN-44");
    expect(await loadAllSkills()).toHaveLength(1);
    await deleteSkill(global.id, B);
    expect(await addRefinementToSharedSkill(held!)).toEqual({ ok: false, reason: "gone" });
    expect(await keepRefinementInSpace(held!)).toEqual({ ok: false, reason: "gone" });
    expect(await loadAllSkills()).toEqual([]);
  });
});
