import { describe, expect, it } from "vitest";
import type { BrowserTaskSessionEvidence } from "./session-evidence";
import {
  autoSkillsToPrune,
  generalizeSteps,
  matchSkill,
  MAX_AUTO_SKILLS,
  planLearning,
  skillHint,
  skillSimilarity
} from "./skill-learning";
import type { UserSkill } from "./skills";

const page = (url: string) => ({ tab_id: 1, url, title: "t" });
const target = (accessible_name: string, role = "textbox") => ({ element_id: "@e1", tag: "input", role, accessible_name });

function evidence(
  actions: Array<Partial<BrowserTaskSessionEvidence["actions"][number]>>,
  task = "search the tea shop for green tea and add the first one to the cart"
): BrowserTaskSessionEvidence {
  return {
    version: 1,
    session_id: "s",
    title: "t",
    task,
    started_at: "",
    status: "completed",
    start: page("https://teashop.example/"),
    tab_evidence: [],
    actions: actions.map((action, index) => ({
      id: `a${index}`,
      ordinal: index,
      recorded_at: "",
      input: {},
      note: "",
      before: page("https://teashop.example/"),
      approval: { required: false, granted: false },
      ...action
    })) as BrowserTaskSessionEvidence["actions"]
  };
}

const longRun = evidence([
  { tool: "navigate", input: { url: "https://teashop.example/" } },
  { tool: "type", input: { text: "green tea" }, target: target("Search") },
  { tool: "press_key", input: { key: "Enter" }, target: target("Search") },
  { tool: "click", target: target("Add to cart", "button") }
]);

function skill(overrides: Partial<UserSkill> = {}): UserSkill {
  return {
    id: "k1",
    name: "Search the tea shop for green tea",
    slug: "search-the-tea-shop-for-green-tea",
    description: "search the tea shop for green tea and add the first one to the cart",
    instructions: "Goal: x\nSteps that worked last time:\n1. Open https://teashop.example/\n2. Click “Menu”\n3. Type “green tea” into “Search”\n4. Press Enter\n5. Click “Add to cart” (button)",
    start_url: "https://teashop.example/",
    source: "auto",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "",
    runs: 0,
    successes: 0,
    failures: 0,
    lessons: [],
    ...overrides
  };
}

describe("skill learning", () => {
  it("matches a new request to a saved Skill only when they really are alike", () => {
    const saved = skill();
    expect(skillSimilarity("search the tea shop for black tea and add it to the cart", saved)).toBeGreaterThan(0.5);
    expect(matchSkill("search the tea shop for black tea and add it to the cart", [saved])?.skill.id).toBe("k1");
    expect(matchSkill("what is the weather in Pune", [saved])).toBeNull();
    expect(matchSkill("tea", [saved])).toBeNull();
    // A Skill that never worked is not pushed on the agent.
    expect(matchSkill("search the tea shop for black tea and add it to the cart", [skill({ runs: 3, successes: 0 })])).toBeNull();
    // Naming the website counts.
    expect(skillSimilarity("teashop add green tea to cart", saved)).toBeCloseTo(
      skillSimilarity("teashop add green tea to cart", { ...saved, start_url: undefined }) + 0.15
    );
  });

  it("hints the agent with the Skill's steps and lessons", () => {
    const hint = skillHint(skill({ runs: 4, successes: 3, lessons: ["The cart button moved to the top"] }));
    expect(hint).toContain("A SAVED SKILL MAY HELP (/search-the-tea-shop-for-green-tea, worked 3 of 4 times)");
    expect(hint).toContain("use the values from this request");
    expect(hint).toContain("3. Type “green tea” into “Search”");
    expect(hint).toContain("- The cart button moved to the top");
  });

  it("turns the request's own words into an input", () => {
    expect(generalizeSteps("1. Type “green tea” into “Search”\n2. Type “Ada” into “Name”", "find Green Tea for me")).toBe(
      "1. Type what I ask for (last time “green tea”) into “Search”\n2. Type “Ada” into “Name”"
    );
  });

  it("learns a multi-step task on its own, but not a short or failed one", () => {
    const plan = planLearning({ task: longRun.task, status: "completed", message: "Done", evidence: longRun, autoSkills: true });
    expect(plan.kind).toBe("learn");
    if (plan.kind === "learn") {
      expect(plan.skill.source).toBe("auto");
      expect(plan.skill.instructions).toContain("Type what I ask for (last time “green tea”) into “Search”");
    }
    const short = evidence([{ tool: "navigate", input: { url: "https://teashop.example/" } }, { tool: "read_page" }]);
    expect(planLearning({ task: "x", status: "completed", message: "", evidence: short, autoSkills: true }).kind).toBe("none");
    expect(planLearning({ task: "x", status: "stopped", message: "", evidence: longRun, autoSkills: true }).kind).toBe("none");
    expect(planLearning({ task: "x", status: "completed", message: "", evidence: longRun, autoSkills: false }).kind).toBe("none");
  });

  it("improves a Skill when a run finds a shorter way, and learns from a failure", () => {
    const used = skill();
    const improved = planLearning({ task: "search the tea shop for green tea", status: "completed", message: "", evidence: longRun, used, autoSkills: true });
    expect(improved.kind).toBe("improve");
    if (improved.kind === "improve") {
      expect(improved.skill.id).toBe("k1");
      expect(improved.skill.instructions).not.toContain("Menu");
      expect(improved.skill.instructions).toContain("Type what I ask for (last time “green tea”)");
    }
    const sameLength = skill({ instructions: "1. a\n2. b\n3. c\n4. d" });
    expect(planLearning({ task: "x", status: "completed", message: "", evidence: longRun, used: sameLength, autoSkills: true })).toEqual({
      kind: "confirm",
      skillId: "k1"
    });
    expect(planLearning({ task: "x", status: "stopped", message: "The shop was closed", used, autoSkills: true })).toEqual({
      kind: "lesson",
      skillId: "k1",
      lesson: "The shop was closed"
    });
    expect(planLearning({ task: "x", status: "error", message: "", used, autoSkills: true }).kind).toBe("none");
  });

  it("keeps the number of unused auto-learned Skills bounded", () => {
    const many = Array.from({ length: MAX_AUTO_SKILLS + 3 }, (_, index) =>
      skill({ id: `a${index}`, created_at: `2026-10-${String(index + 1).padStart(2, "0")}T00:00:00Z` })
    );
    const kept = [skill({ id: "kept", source: "chat" }), skill({ id: "used", runs: 2, created_at: "2000-01-01" })];
    const pruned = autoSkillsToPrune([...many, ...kept]);
    expect(pruned).toEqual(["a2", "a1", "a0"]);
  });
});
