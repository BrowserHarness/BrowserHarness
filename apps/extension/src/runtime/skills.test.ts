import { beforeEach, describe, expect, it } from "vitest";
import type { BrowserTaskSessionEvidence } from "./session-evidence";
import {
  loadSkills,
  fetchSkillMd,
  parseSkillMd,
  skillFileUrl,
  recordSkillRun,
  refreshSkillSteps,
  renameSkill,
  saveSkill,
  skillFromSession,
  skillSlug,
  skillTask,
  toSkillMd,
  worthSaving
} from "./skills";

let store: Record<string, unknown>;
beforeEach(() => {
  store = {};
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: store[key] }),
          set: async (value: Record<string, unknown>) => {
            Object.assign(store, value);
          },
          remove: async (key: string) => {
            delete store[key];
          }
        }
      }
    }
  });
});

const page = (url: string) => ({ tab_id: 1, url, title: "t" });
function session(actions: Array<Partial<BrowserTaskSessionEvidence["actions"][number]>>): BrowserTaskSessionEvidence {
  return {
    version: 1,
    session_id: "s",
    title: "t",
    task: "search the shop for red shoes and open the first result",
    started_at: "2026-10-05T00:00:00Z",
    status: "completed",
    start: page("https://shop.example/"),
    tab_evidence: [],
    actions: actions.map((action, index) => ({
      id: `a${index}`,
      ordinal: index,
      recorded_at: "2026-10-05T00:00:00Z",
      input: {},
      note: "",
      before: page("https://shop.example/"),
      approval: { required: false, granted: false },
      ...action
    })) as BrowserTaskSessionEvidence["actions"]
  };
}

const target = (accessible_name: string, role = "textbox", type?: string) => ({
  element_id: "@e1",
  tag: "input",
  role,
  accessible_name,
  ...(type ? { type } : {})
});

describe("skills", () => {
  it("turns what the agent did into plain steps, never keeping a password", () => {
    const evidence = session([
      { tool: "observe_page" },
      { tool: "type", input: { text: "red shoes" }, target: target("Search") },
      { tool: "press_key", input: { key: "Enter" }, target: target("Search") },
      { tool: "type", input: { text: "hunter2" }, target: target("Password", "textbox", "password") },
      { tool: "click", target: target("Red shoe", "link") }
    ]);
    const skill = skillFromSession(evidence);
    expect(skill.name).toBe("Search the shop for red shoes and open…");
    expect(skill.instructions).toContain("Start at https://shop.example/.");
    expect(skill.instructions).toContain("1. Type “red shoes” into “Search”");
    expect(skill.instructions).toContain("2. Press Enter in “Search”");
    expect(skill.instructions).toContain("3. Fill in “Password” (ask me for the value)");
    expect(skill.instructions).toContain("4. Click “Red shoe” (link)");
    expect(skill.instructions).not.toContain("hunter2");
    expect(worthSaving(evidence)).toBe(true);
    expect(worthSaving(session([{ tool: "read_page" }]))).toBe(false);
  });

  it("keeps slugs unique and clear of built-in commands", async () => {
    const draft = skillFromSession(session([{ tool: "read_page" }]));
    const first = await saveSkill({ ...draft, name: "Help", slug: "" }, ["help"]);
    expect(first.slug).toBe("help-2");
    const second = await saveSkill({ ...draft, id: "other", name: "Help", slug: "" }, ["help"]);
    expect(second.slug).toBe("help-3");
    const renamed = await renameSkill(second.id, "Check prices", ["help"]);
    expect(renamed?.slug).toBe("check-prices");
    expect((await loadSkills()).length).toBe(2);
    expect(skillSlug("Réserver un vol!")).toBe("reserver-un-vol");
  });

  it("learns from failed runs and hands the lessons to the next run", async () => {
    const skill = await saveSkill(skillFromSession(session([{ tool: "read_page" }])));
    await recordSkillRun(skill.id, "failed", "The Search box moved to the top menu.");
    const after = await recordSkillRun(skill.id, "worked");
    expect(after).toMatchObject({ runs: 2, successes: 1, failures: 1, lessons: ["The Search box moved to the top menu."] });
    const task = skillTask(after!, "size 9");
    expect(task).toContain("Lessons from earlier runs");
    expect(task).toContain("This time: size 9");
    const refreshed = refreshSkillSteps(after!, session([{ tool: "click", target: target("Menu", "button") }]));
    expect(refreshed.instructions).toContain("Click “Menu” (button)");
    expect(refreshed.lessons).toEqual([]);
  });

  it("round-trips the SKILL.md format and rejects files without a name", () => {
    const skill = { ...skillFromSession(session([{ tool: "read_page" }])), lessons: ["Log in first"] };
    const md = toSkillMd(skill);
    expect(md.startsWith("---\nname: search-the-shop-for-red-shoes-and-open\n")).toBe(true);
    const parsed = parseSkillMd(md);
    expect(parsed.ok && parsed.skill).toMatchObject({
      name: skill.name,
      instructions: skill.instructions,
      lessons: ["Log in first"],
      source: "import"
    });
    const plain = parseSkillMd("---\nname: weekly-report\ndescription: 'Pull the weekly numbers'\n---\nOpen the dashboard and read the totals.");
    expect(plain.ok && plain.skill).toMatchObject({ name: "weekly-report", slug: "weekly-report", description: "Pull the weekly numbers" });
    expect(parseSkillMd("just text").ok).toBe(false);
    expect(parseSkillMd("").ok).toBe(false);
  });
});

describe("importing a Skill from a link", () => {
  it("finds the raw SKILL.md behind GitHub links", () => {
    expect(skillFileUrl("https://github.com/acme/skills/blob/main/tea/SKILL.md")).toBe("https://raw.githubusercontent.com/acme/skills/main/tea/SKILL.md");
    expect(skillFileUrl("https://github.com/acme/skills/tree/main/tea")).toBe("https://raw.githubusercontent.com/acme/skills/main/tea/SKILL.md");
    expect(skillFileUrl("https://github.com/acme/tea-skill")).toBe("https://raw.githubusercontent.com/acme/tea-skill/HEAD/SKILL.md");
    expect(skillFileUrl("https://example.com/skills/tea.md")).toBe("https://example.com/skills/tea.md");
    expect(skillFileUrl("http://example.com/tea.md")).toBeNull();
    expect(skillFileUrl("not a link")).toBeNull();
  });

  it("downloads and reads it, and refuses web pages", async () => {
    const ok = await fetchSkillMd("https://example.com/tea.md", (async () =>
      new Response("---\nname: Order tea\n---\n1. Open the shop\n2. Add tea", { headers: { "content-type": "text/plain" } })) as typeof fetch);
    expect(ok.ok && ok.skill.name).toBe("Order tea");
    const page = await fetchSkillMd("https://example.com/tea", (async () => new Response("<html></html>", { headers: { "content-type": "text/html" } })) as typeof fetch);
    expect(page).toMatchObject({ ok: false });
    const missing = await fetchSkillMd("https://example.com/none.md", (async () => new Response("no", { status: 404 })) as typeof fetch);
    expect(missing).toEqual({ ok: false, error: "Couldn't download that link (404)." });
  });
});
