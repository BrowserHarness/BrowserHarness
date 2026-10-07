// Skills the person keeps: saved from a finished chat task, from a recording,
// or imported as a SKILL.md file. Each one is plain instructions the agent
// follows by intent, plus lessons it picks up from earlier runs.
import { SECRET_FIELD_NAME } from "./memory-write/sensitivity";
import { renderIntentPrompt, workflowToIntentSkill } from "./intent-skill";
import type { BrowserTaskSessionEvidence } from "./session-evidence";
import type { SavedWorkflow } from "./workflows";
import { recordSpace, resolveSpace, withinSpace } from "./memory-scope";
import { DEFAULT_SPACE_ID, loadSpaces } from "./spaces";

async function spaceExists(id: string): Promise<boolean> {
  if (id === DEFAULT_SPACE_ID) return true;
  return (await loadSpaces()).spaces.some((space) => space.id === id);
}

export interface UserSkill {
  id: string;
  name: string;
  /** Lower-case, dash separated; also the slash command (`/name`). */
  slug: string;
  description: string;
  /** Markdown steps the agent follows. */
  instructions: string;
  start_url?: string;
  /** "auto": learned without being asked; becomes "chat" once the person keeps it. */
  source: "chat" | "recording" | "import" | "auto";
  created_at: string;
  updated_at: string;
  runs: number;
  successes: number;
  failures: number;
  last_run_at?: string;
  /** What went wrong before, newest first; given to the agent on the next run. */
  lessons: string[];
  /** The Space the Skill was made or learned in. It is only offered there. */
  space_id?: string;
  /**
   * "space" (the default for new Skills): only in its own Space. "all": in
   * every Space; Skills saved before Spaces had a say keep working everywhere.
   */
  visibility?: "space" | "all";
  /**
   * Saved before Skills belonged to a Space: it has no Space of its own and
   * is shared by every Space. Set when read; its origin is not guessed.
   */
  legacy?: boolean;
  /** How the Skill came to be. Missing on Skills saved before this was kept; never guessed for them. */
  provenance?: SkillProvenance;
}

/** How a Skill came to be. Changing where it can be used never changes this. */
export interface SkillProvenance {
  origin: "learned" | "saved" | "recording" | "imported" | "copied" | "legacy";
  /** The Space it was made in (for a copy: the Space it was copied into). */
  space_id?: string;
  at?: string;
  /** For a copy: the Skill and Space it was copied from, and when. */
  source_skill_id?: string;
  source_space_id?: string;
  copied_at?: string;
}

/** Where a Skill can be used, in plain words for the Skill card. */
export type SkillReach = "this-space" | "every-space";
export function skillReach(skill: UserSkill): SkillReach {
  return skill.visibility === "all" ? "every-space" : "this-space";
}

const KEY = "browserharness.skills";
/** At most this many Skills per Space, and this many shared with every Space, so one busy Space never pushes out another's. */
export const MAX_SKILLS = 200;
const MAX_LESSONS = 8;
const MAX_INSTRUCTIONS = 8000;

/** Words that must never be stored as a remembered value. */
// One list of secret field names, shared with the memory safety check.
const SECRET = SECRET_FIELD_NAME;

export function skillSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "skill";
}

export function uniqueSlug(base: string, taken: string[], ownId?: string, skills: UserSkill[] = []): string {
  const others = new Set(
    skills.filter((skill) => skill.id !== ownId).map((skill) => skill.slug).concat(taken)
  );
  if (!others.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const next = `${base}-${index}`;
    if (!others.has(next)) return next;
  }
}

/**
 * A Skill saved before Skills belonged to a Space was shared by every Space,
 * and still is: it reads as an every-Space Skill marked legacy, with no Space
 * and no invented origin.
 */
function normalizeSkill(skill: UserSkill): UserSkill {
  if (skill.space_id || skill.visibility) return skill;
  return { ...skill, visibility: "all", legacy: true, provenance: skill.provenance ?? { origin: "legacy" } };
}

/** The origin a new Skill gets from the way it was made. */
function originOf(skill: UserSkill): SkillProvenance["origin"] {
  switch (skill.source) {
    case "auto":
      return "learned";
    case "recording":
      return "recording";
    case "import":
      return "imported";
    default:
      return "saved";
  }
}

/** Every Skill in every Space. Only for keeping slugs unique and for storage. */
export async function loadAllSkills(): Promise<UserSkill[]> {
  const stored = await chrome.storage.local.get(KEY);
  const value = stored[KEY];
  return Array.isArray(value) ? (value as UserSkill[]).map(normalizeSkill) : [];
}

/**
 * The Skills this Space may use: its own plus any shared with every Space.
 * Pass the Space a task started in; without one, the Space in use now.
 */
export async function loadSkills(spaceId?: string): Promise<UserSkill[]> {
  return withinSpace(await loadAllSkills(), await resolveSpace(spaceId));
}

/** True when the Skill was made in this Space only (not shared with every Space). */
export function ownedBySpace(skill: UserSkill, spaceId: string): boolean {
  return skill.visibility !== "all" && recordSpace(skill) === spaceId;
}

/** Who a Skill's room counts against: its own Space, or the every-Space shelf. */
function shelf(skill: UserSkill): string {
  return skill.visibility === "all" ? "\u0000all" : recordSpace(skill);
}

/** Newest first, at most MAX_SKILLS per Space and MAX_SKILLS shared ones: a busy Space only ever pushes out its own. */
export function cappedSkills(skills: UserSkill[]): UserSkill[] {
  const counts = new Map<string, number>();
  return skills.filter((skill) => {
    const key = shelf(skill);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return count <= MAX_SKILLS;
  });
}

/** Saves the store, capped per shelf; returns what was kept. */
async function store(skills: UserSkill[]): Promise<UserSkill[]> {
  const kept = cappedSkills(skills);
  await chrome.storage.local.set({ [KEY]: kept });
  return kept;
}

/**
 * Adds or replaces a Skill; the slug is made unique among the others (in
 * every Space, so a /command never means two things). A new Skill belongs
 * to the given Space, or the one in use now.
 */
export async function saveSkill(skill: UserSkill, reserved: string[] = [], spaceId?: string): Promise<UserSkill> {
  const skills = await loadAllSkills();
  const existing = skills.find((item) => item.id === skill.id);
  const scope =
    existing?.space_id || existing?.visibility
      ? { space_id: existing.space_id, visibility: existing.visibility }
      : skill.space_id || skill.visibility
        ? { space_id: skill.space_id, visibility: skill.visibility }
        : { space_id: await resolveSpace(spaceId), visibility: "space" as const };
  // Where it came from is kept as first recorded (keeping a learned Skill doesn't make it "saved").
  const provenance =
    existing?.provenance ?? skill.provenance ?? (existing ? undefined : { origin: originOf(skill), space_id: scope.space_id, at: new Date().toISOString() });
  const next: UserSkill = {
    ...skill,
    ...(provenance ? { provenance } : {}),
    ...(scope.space_id ? { space_id: scope.space_id } : {}),
    ...(scope.visibility ? { visibility: scope.visibility } : {}),
    instructions: skill.instructions.slice(0, MAX_INSTRUCTIONS),
    slug: uniqueSlug(skillSlug(skill.slug || skill.name), reserved, skill.id, skills),
    updated_at: new Date().toISOString()
  };
  await store([next, ...skills.filter((item) => item.id !== skill.id)]);
  return next;
}

/** Deletes a Skill this Space can see; Skills of other Spaces are never touched. */
export async function deleteSkill(id: string, spaceId?: string): Promise<void> {
  const visible = new Set((await loadSkills(spaceId)).map((skill) => skill.id));
  if (!visible.has(id)) return;
  await store((await loadAllSkills()).filter((skill) => skill.id !== id));
}

/**
 * Makes one Skill available in every Space, or only in this one. It is the
 * same Skill either way: id, name, steps, lessons, run counts and origin stay.
 * Making it available everywhere is only offered for a Skill of this Space;
 * "only this Space" moves a shared Skill into the Space it is used from.
 *
 * The moved Skill goes first, like any Skill just saved, so it always keeps
 * its place on a full shelf: the one saved longest ago on that shelf makes
 * room. Other shelves are not touched.
 */
export async function setSkillReach(id: string, reach: SkillReach, spaceId?: string): Promise<UserSkill | null> {
  const space = await resolveSpace(spaceId);
  const skills = await loadAllSkills();
  const skill = skills.find((item) => item.id === id);
  if (!skill || !withinSpace([skill], space).length) return null;
  if (reach === "every-space" && !ownedBySpace(skill, space)) return skill.visibility === "all" ? skill : null;
  const next: UserSkill =
    reach === "every-space"
      ? { ...skill, visibility: "all", updated_at: new Date().toISOString() }
      : { ...skill, visibility: "space", space_id: space, legacy: undefined, updated_at: new Date().toISOString() };
  if (!next.legacy) delete next.legacy;
  const kept = await store([next, ...skills.filter((item) => item.id !== id)]);
  // Never report a move the store didn't keep.
  return kept.some((item) => item.id === id) ? next : null;
}

/**
 * Copies a Skill into another Space as a new, independent Skill: the same
 * name, steps and lessons to start from, its own id, a fresh run count, and a
 * note of where it was copied from. Changing either one never changes the other.
 */
export async function copySkillToSpace(id: string, toSpaceId: string, fromSpaceId?: string, reserved: string[] = []): Promise<UserSkill | null> {
  const from = await resolveSpace(fromSpaceId);
  const original = (await loadSkills(from)).find((item) => item.id === id);
  if (!original || !toSpaceId) return null;
  // Copying a Space's own Skill into the same Space would only make a twin.
  if (original.visibility !== "all" && recordSpace(original) === toSpaceId) return null;
  if (!(await spaceExists(toSpaceId))) return null;
  const now = new Date().toISOString();
  const copy: UserSkill = {
    id: crypto.randomUUID(),
    name: original.name,
    slug: original.slug,
    description: original.description,
    instructions: original.instructions,
    ...(original.start_url ? { start_url: original.start_url } : {}),
    // A copy is something the person chose to keep, not a draft learned on its own.
    source: original.source === "auto" ? "chat" : original.source,
    created_at: now,
    updated_at: now,
    runs: 0,
    successes: 0,
    failures: 0,
    lessons: [...original.lessons],
    space_id: toSpaceId,
    visibility: "space",
    provenance: {
      origin: "copied",
      space_id: toSpaceId,
      at: now,
      source_skill_id: original.id,
      // Where the original was made, never the Space it happened to be viewed from; unknown for a legacy Skill.
      ...(original.space_id ? { source_space_id: original.space_id } : {}),
      copied_at: now
    }
  };
  return saveSkill(copy, reserved, toSpaceId);
}

export async function renameSkill(id: string, name: string, reserved: string[] = [], spaceId?: string): Promise<UserSkill | null> {
  const skill = (await loadSkills(spaceId)).find((item) => item.id === id);
  const clean = name.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!skill || !clean) return null;
  return saveSkill({ ...skill, name: clean, slug: skillSlug(clean) }, reserved, spaceId);
}

/** Counts a run. A failure leaves a lesson the agent reads next time. */
export async function recordSkillRun(
  id: string,
  outcome: "worked" | "failed",
  lesson?: string
): Promise<UserSkill | null> {
  const skills = await loadAllSkills();
  const skill = skills.find((item) => item.id === id);
  if (!skill) return null;
  const note = lesson?.replace(/\s+/g, " ").trim().slice(0, 240);
  const next: UserSkill = {
    ...skill,
    runs: skill.runs + 1,
    successes: skill.successes + (outcome === "worked" ? 1 : 0),
    failures: skill.failures + (outcome === "failed" ? 1 : 0),
    last_run_at: new Date().toISOString(),
    lessons:
      outcome === "failed" && note
        ? [note, ...skill.lessons.filter((item) => item !== note)].slice(0, MAX_LESSONS)
        : skill.lessons
  };
  await store(skills.map((item) => (item.id === id ? next : item)));
  return next;
}

/** Adds a lesson without counting a run (the person chose to keep it). */
export async function addSkillLesson(id: string, lesson: string): Promise<UserSkill | null> {
  const skills = await loadAllSkills();
  const skill = skills.find((item) => item.id === id);
  const note = lesson.replace(/\s+/g, " ").trim().slice(0, 240);
  if (!skill || !note) return skill ?? null;
  const next: UserSkill = { ...skill, lessons: [note, ...skill.lessons.filter((item) => item !== note)].slice(0, MAX_LESSONS), updated_at: new Date().toISOString() };
  await store(skills.map((item) => (item.id === id ? next : item)));
  return next;
}

function quote(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 60);
  return clean ? `“${clean}”` : "the control";
}

/**
 * Plain steps from what the agent actually did. Typed text becomes an input
 * the person can change; secrets are never kept.
 */
export function stepsFromSession(evidence: BrowserTaskSessionEvidence): string[] {
  const steps: string[] = [];
  const push = (step: string) => {
    if (steps.at(-1) !== step) steps.push(step);
  };
  for (const action of evidence.actions) {
    const input = action.input || {};
    const target = action.target;
    const name = target?.accessible_name || "";
    switch (action.tool) {
      case "navigate":
      case "open_tab":
        if (typeof input.url === "string") push(`Open ${input.url}`);
        break;
      case "back":
        push("Go back to the previous page");
        break;
      case "click":
      case "trusted_click":
        push(`Click ${quote(name)}${target?.role ? ` (${target.role})` : ""}`);
        break;
      case "type":
      case "trusted_type": {
        const text = String(input.text ?? "");
        const secret = target?.type === "password" || SECRET.test(name);
        push(
          secret || !text
            ? `Fill in ${quote(name)} (ask me for the value)`
            : `Type “${text.slice(0, 80)}” into ${quote(name)}`
        );
        break;
      }
      case "press_key":
      case "trusted_key":
      case "send_keys":
        push(`Press ${String(input.key ?? input.keys ?? "the key")}${name ? ` in ${quote(name)}` : ""}`);
        break;
      case "select_option":
        push(`Choose “${String(input.value ?? input.values ?? "")}” in ${quote(name)}`);
        break;
      case "extract_table":
        push("Read the tables on the page");
        break;
      case "read_page":
      case "find":
      case "ax_snapshot":
        push("Read the page to find what is needed");
        break;
      case "upload":
        push("Upload the file I give you");
        break;
      case "save_pdf":
        push("Save the page as a PDF");
        break;
      default:
        break;
    }
  }
  return steps.slice(0, 30);
}

function titleFrom(task: string): string {
  const firstLine = task.split("\n")[0].replace(/\s+/g, " ").trim();
  const words = firstLine.split(" ").slice(0, 8).join(" ");
  const name = words.length < firstLine.length ? `${words}…` : words;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** A Skill draft from a finished task, for the person to name and keep. */
export function skillFromSession(evidence: BrowserTaskSessionEvidence): UserSkill {
  const steps = stepsFromSession(evidence);
  const now = new Date().toISOString();
  const name = titleFrom(evidence.task);
  const start = evidence.start?.url && /^https?:/.test(evidence.start.url) ? evidence.start.url : undefined;
  const instructions = [
    `Goal: ${evidence.task.replace(/\s+/g, " ").trim().slice(0, 400)}`,
    "",
    ...(start ? [`Start at ${start}.`] : []),
    "Steps that worked last time (adapt if the page has changed, and re-read the page after each step):",
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "Finish by telling me the result."
  ].join("\n");
  return {
    id: crypto.randomUUID(),
    name,
    slug: skillSlug(name),
    description: evidence.task.replace(/\s+/g, " ").trim().slice(0, 160),
    instructions,
    start_url: start,
    source: "chat",
    created_at: now,
    updated_at: now,
    runs: 0,
    successes: 0,
    failures: 0,
    lessons: []
  };
}

/** A Skill from a Watch Me recording, followed by intent rather than replayed exactly. */
export function skillFromRecording(workflow: SavedWorkflow): UserSkill {
  const intent = workflowToIntentSkill(workflow);
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: workflow.name,
    slug: skillSlug(workflow.name),
    description: `Recorded on ${new Date(workflow.created_at).toLocaleDateString()} starting at ${workflow.url}`,
    instructions: renderIntentPrompt(intent),
    start_url: workflow.url,
    source: "recording",
    created_at: now,
    updated_at: now,
    runs: 0,
    successes: 0,
    failures: 0,
    lessons: []
  };
}

/** Whether a finished task did enough to be worth offering as a Skill. */
export function worthSaving(evidence: BrowserTaskSessionEvidence | undefined): boolean {
  return Boolean(evidence && evidence.status === "completed" && stepsFromSession(evidence).length >= 2);
}

/** Replaces a Skill's steps with the ones from a newer, successful run. */
export function refreshSkillSteps(skill: UserSkill, evidence: BrowserTaskSessionEvidence): UserSkill {
  const fresh = skillFromSession({ ...evidence, task: skill.description || evidence.task });
  return { ...skill, instructions: fresh.instructions, start_url: fresh.start_url ?? skill.start_url, lessons: [] };
}

/** The task the agent runs for `/skill-name extra details`. */
export function skillTask(skill: UserSkill, details = ""): string {
  return [
    `Use my saved Skill “${skill.name}”.`,
    skill.instructions,
    ...(skill.lessons.length
      ? ["", "Lessons from earlier runs (avoid these problems):", ...skill.lessons.map((lesson) => `- ${lesson}`)]
      : []),
    ...(details.trim() ? ["", `This time: ${details.trim()}`] : [])
  ].join("\n");
}

function yamlValue(text: string): string {
  return JSON.stringify(text.replace(/\s+/g, " ").trim());
}

/** The open SKILL.md format: YAML front matter, then the instructions. */
export function toSkillMd(skill: Pick<UserSkill, "slug" | "name" | "description" | "instructions" | "lessons">): string {
  return [
    "---",
    `name: ${skill.slug}`,
    `description: ${yamlValue(skill.description || skill.name)}`,
    "---",
    "",
    `# ${skill.name}`,
    "",
    skill.instructions.trim(),
    ...(skill.lessons.length
      ? ["", "## Lessons from earlier runs", "", ...skill.lessons.map((lesson) => `- ${lesson}`)]
      : []),
    ""
  ].join("\n");
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try {
      return String(JSON.parse(trimmed));
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'");
  return trimmed;
}

export type ParsedSkillMd =
  | { ok: true; skill: UserSkill }
  | { ok: false; error: string };

/** Reads a SKILL.md file into a Skill. Nothing in it is run on import. */
export function parseSkillMd(text: string): ParsedSkillMd {
  const source = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!source.trim()) return { ok: false, error: "The file is empty." };
  if (source.length > 50_000) return { ok: false, error: "The file is too large for a Skill (50 KB at most)." };
  let body = source;
  const meta: Record<string, string> = {};
  const front = /^---\n([\s\S]*?)\n---\n?/.exec(source);
  if (front) {
    body = source.slice(front[0].length);
    for (const line of front[1].split("\n")) {
      const pair = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
      if (pair) meta[pair[1].toLowerCase()] = unquote(pair[2]);
    }
  }
  const heading = /^#\s+(.+)$/m.exec(body);
  const lessonsAt = body.search(/^##\s+Lessons from earlier runs\s*$/m);
  const lessons =
    lessonsAt >= 0
      ? body
          .slice(lessonsAt)
          .split("\n")
          .filter((line) => /^\s*-\s+/.test(line))
          .map((line) => line.replace(/^\s*-\s+/, "").trim())
          .slice(0, MAX_LESSONS)
      : [];
  let instructions = (lessonsAt >= 0 ? body.slice(0, lessonsAt) : body).trim();
  if (heading && instructions.startsWith(heading[0])) instructions = instructions.slice(heading[0].length).trim();
  const name = (heading?.[1] || meta.name || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!name) return { ok: false, error: "The file has no name: add `name:` front matter or a `# Title` line." };
  if (!instructions) return { ok: false, error: "The file has no instructions." };
  const now = new Date().toISOString();
  return {
    ok: true,
    skill: {
      id: crypto.randomUUID(),
      name,
      slug: skillSlug(meta.name || name),
      description: (meta.description || name).slice(0, 300),
      instructions: instructions.slice(0, MAX_INSTRUCTIONS),
      source: "import",
      created_at: now,
      updated_at: now,
      runs: 0,
      successes: 0,
      failures: 0,
      lessons
    }
  };
}

export const SKILLS_STORAGE_KEY = KEY;

/**
 * The address of the SKILL.md behind a link people share: a GitHub file or
 * folder page becomes its raw file; any other https link is used as it is.
 */
export function skillFileUrl(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname === "github.com") {
    const [owner, repo, kind, ref, ...rest] = url.pathname.split("/").filter(Boolean);
    if (!owner || !repo) return null;
    if (kind === "blob" && ref && rest.length) return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${rest.join("/")}`;
    if (kind === "tree" && ref) return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${[...rest, "SKILL.md"].join("/")}`;
    if (!kind) return `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/SKILL.md`;
    return null;
  }
  return url.toString();
}

/** Downloads a shared SKILL.md and reads it; nothing in it runs. */
export async function fetchSkillMd(link: string, fetchImpl: typeof fetch = fetch): Promise<ParsedSkillMd> {
  const address = skillFileUrl(link);
  if (!address) return { ok: false, error: "Paste an https link to a SKILL.md file (a GitHub file or folder link works too)." };
  let response: Response;
  try {
    response = await fetchImpl(address, { credentials: "omit", redirect: "follow", signal: AbortSignal.timeout(15_000) });
  } catch {
    return { ok: false, error: "Couldn't download that link." };
  }
  if (!response.ok) return { ok: false, error: `Couldn't download that link (${response.status}).` };
  if (Number(response.headers.get("content-length") || 0) > 50_000) return { ok: false, error: "The file is too large for a Skill (50 KB at most)." };
  if (/text\/html/i.test(response.headers.get("content-type") || "")) {
    return { ok: false, error: "That link is a web page, not a SKILL.md file. Use the file's raw link." };
  }
  return parseSkillMd((await response.text()).slice(0, 50_001));
}
