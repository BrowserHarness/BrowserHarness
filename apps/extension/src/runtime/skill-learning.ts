// Skills that write and improve themselves: a finished multi-step task is kept
// as a Skill without anyone pressing a button, a new request that looks like a
// saved Skill gets that Skill's steps as a hint, and each run either confirms,
// shortens or teaches the Skill a lesson.
import type { BrowserTaskSessionEvidence } from "./session-evidence";
import { resolveSpace } from "./memory-scope";
import {
  addSkillLesson,
  copySkillToSpace,
  deleteSkill,
  loadAllSkills,
  ownedBySpace,
  recordSkillRun,
  refreshSkillSteps,
  saveSkill,
  skillFromSession,
  stepsFromSession,
  type UserSkill
} from "./skills";

/** Auto-learned Skills nobody kept or used; the oldest go first past this. */
export const MAX_AUTO_SKILLS = 30;
/** A task needs this many distinct steps before it is worth learning. */
export const MIN_STEPS_TO_LEARN = 3;
const MATCH_THRESHOLD = 0.5;

const STOP_WORDS = new Set(
  "a an and are as at be by can could do does for from get go i in into is it its me my of on or please show tell that the then this to up us what when where which with would you your".split(
    " "
  )
);

function hostOf(url?: string): string {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
}

export function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
      .map((word) => (word.length > 5 ? word.replace(/(ing|ed)$/, "") : word))
      .map((word) => (word.length > 3 && !word.endsWith("ss") ? word.replace(/s$/, "") : word))
  );
}

/**
 * How alike a request and a Skill are, 0 to 1: shared words over all words,
 * plus a little when the request names the Skill's website.
 */
export function skillSimilarity(task: string, skill: Pick<UserSkill, "name" | "description" | "start_url">): number {
  const asked = contentWords(task);
  const host = hostOf(skill.start_url);
  const known = contentWords(`${skill.name} ${skill.description}`);
  if (!asked.size || !known.size) return 0;
  let shared = 0;
  for (const word of asked) if (known.has(word)) shared += 1;
  if (shared < 2) return 0;
  const union = new Set([...asked, ...known]).size;
  const siteNamed = host && host.split(".").some((part) => part.length > 2 && asked.has(part)) ? 0.15 : 0;
  return Math.min(1, shared / union + siteNamed);
}

/**
 * The saved Skill that best fits a new request, if one fits well enough.
 * Pass only the Skills the Space may use (loadSkills), never all of them.
 * When a Space's own Skill and an every-Space Skill fit equally well, the
 * Space's own one wins.
 */
export function matchSkill(task: string, skills: UserSkill[]): { skill: UserSkill; score: number } | null {
  let best: { skill: UserSkill; score: number } | null = null;
  for (const skill of skills) {
    // A Skill that keeps failing is not offered as a hint.
    if (skill.runs >= 3 && skill.successes === 0) continue;
    const score = skillSimilarity(task, skill);
    if (score < MATCH_THRESHOLD) continue;
    const ownBeatsShared = best && score === best.score && skill.visibility !== "all" && best.skill.visibility === "all";
    if (!best || score > best.score || ownBeatsShared) best = { skill, score };
  }
  return best;
}

/** The block added to the agent's task when a saved Skill matches. */
export function skillHint(skill: UserSkill): string {
  const record = skill.runs ? `, worked ${skill.successes} of ${skill.runs} times` : "";
  return [
    "",
    "",
    `A SAVED SKILL MAY HELP (/${skill.slug}${record}). Follow it only where it fits this request and the page as it is now; use the values from this request, not the old ones:`,
    skill.instructions,
    ...(skill.lessons.length
      ? ["Lessons from earlier runs (avoid these problems):", ...skill.lessons.map((lesson) => `- ${lesson}`)]
      : [])
  ].join("\n");
}

/**
 * "Type “red shoes” into “Search”" becomes "Type what I ask for (last time
 * “red shoes”) into “Search”" when the words came from the request, so a
 * learned Skill works for the next search too.
 */
export function generalizeSteps(instructions: string, task: string): string {
  const request = task.toLowerCase();
  return instructions.replace(/^(\d+\. )Type “([^”]+)” into (.+)$/gm, (line, number: string, text: string, target: string) =>
    request.includes(text.toLowerCase()) ? `${number}Type what I ask for (last time “${text}”) into ${target}` : line
  );
}

function stepCount(instructions: string): number {
  return instructions.split("\n").filter((line) => /^\d+\. /.test(line)).length;
}

export type LearningPlan =
  | { kind: "none" }
  | { kind: "learn"; skill: UserSkill }
  | { kind: "improve"; skill: UserSkill }
  | { kind: "confirm"; skillId: string }
  | { kind: "lesson"; skillId: string; lesson: string };

/** What a finished task teaches: a new Skill, a better one, or a lesson. */
export function planLearning(input: {
  task: string;
  status: "completed" | "stopped" | "approval-cancelled" | "error";
  message: string;
  evidence?: BrowserTaskSessionEvidence;
  /** The Skill this run followed (a /command or a matched hint). */
  used?: UserSkill | null;
  autoSkills: boolean;
}): LearningPlan {
  const { used, evidence } = input;
  if (used) {
    if (input.status === "stopped") return { kind: "lesson", skillId: used.id, lesson: input.message };
    if (input.status !== "completed") return { kind: "none" };
    const steps = evidence ? stepsFromSession(evidence) : [];
    const before = stepCount(used.instructions);
    if (evidence && steps.length >= 2 && before > 0 && steps.length < before) {
      const refreshed = refreshSkillSteps(used, evidence);
      return {
        kind: "improve",
        skill: { ...refreshed, instructions: generalizeSteps(refreshed.instructions, input.task) }
      };
    }
    return { kind: "confirm", skillId: used.id };
  }
  if (!input.autoSkills || input.status !== "completed" || !evidence) return { kind: "none" };
  if (new Set(stepsFromSession(evidence)).size < MIN_STEPS_TO_LEARN) return { kind: "none" };
  const draft = skillFromSession({ ...evidence, task: input.task });
  return {
    kind: "learn",
    skill: { ...draft, source: "auto", instructions: generalizeSteps(draft.instructions, input.task) }
  };
}

/** Auto-learned Skills to drop: never kept or run, oldest first, beyond the limit. */
export function autoSkillsToPrune(skills: UserSkill[]): string[] {
  const idle = skills
    .filter((skill) => skill.source === "auto" && skill.runs === 0)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return idle.slice(MAX_AUTO_SKILLS).map((skill) => skill.id);
}

/**
 * A lesson or a shorter way found while running an every-Space Skill in one
 * Space. It may hold that Space's own details ("department code FIN-44"), so
 * it is not written into the shared Skill on its own: the person chooses to
 * add it for every Space or keep a copy for this Space with it.
 */
export interface HeldRefinement {
  skillId: string;
  slug: string;
  /** The Space the run happened in. */
  spaceId: string;
  lesson?: string;
  improved?: Pick<UserSkill, "instructions" | "start_url">;
}

export interface LearningResult {
  /** A Skill learned or improved by this run. */
  saved: UserSkill | null;
  /** Something learned about a shared Skill, waiting for the person. */
  held?: HeldRefinement;
}

/**
 * Carries out a plan in the Space the task ran in. A learned Skill belongs to
 * that Space, and only that Space's own unused Skills make room for it. A
 * Skill shared with every Space only has its run counted: a lesson or new
 * steps from one Space are held for the person instead of changing it for all.
 */
export async function applyLearningPlan(plan: LearningPlan, reserved: string[] = [], spaceId?: string): Promise<LearningResult> {
  const space = await resolveSpace(spaceId);
  if (plan.kind === "learn") {
    const saved = await saveSkill(plan.skill, reserved, space);
    const own = (await loadAllSkills()).filter((skill) => ownedBySpace(skill, space));
    for (const id of autoSkillsToPrune(own)) await deleteSkill(id, space);
    return { saved };
  }
  const id = plan.kind === "improve" ? plan.skill.id : plan.kind === "none" ? "" : plan.skillId;
  const current = id ? (await loadAllSkills()).find((skill) => skill.id === id) : undefined;
  const shared = current?.visibility === "all";
  if (plan.kind === "improve") {
    if (shared && current) {
      await recordSkillRun(current.id, "worked");
      return { saved: null, held: { skillId: current.id, slug: current.slug, spaceId: space, improved: { instructions: plan.skill.instructions, start_url: plan.skill.start_url } } };
    }
    const saved = await saveSkill(plan.skill, reserved, space);
    await recordSkillRun(saved.id, "worked");
    return { saved };
  }
  if (plan.kind === "confirm") await recordSkillRun(plan.skillId, "worked");
  if (plan.kind === "lesson") {
    if (shared && current) {
      await recordSkillRun(current.id, "failed");
      return { saved: null, held: { skillId: current.id, slug: current.slug, spaceId: space, lesson: plan.lesson } };
    }
    await recordSkillRun(plan.skillId, "failed", plan.lesson);
  }
  return { saved: null };
}

/** What happened to a held refinement; "changed" when the Skill was deleted, unshared or moved out of reach meanwhile. */
export type RefinementResult = { ok: true; skill: UserSkill } | { ok: false; reason: "gone" | "changed" };

/**
 * The person chose to add a held lesson or new steps to the shared Skill, for
 * every Space. It is only applied if the Skill is still shared with every Space.
 */
export async function addRefinementToSharedSkill(held: HeldRefinement, reserved: string[] = []): Promise<RefinementResult> {
  const current = (await loadAllSkills()).find((skill) => skill.id === held.skillId);
  if (!current) return { ok: false, reason: "gone" };
  if (current.visibility !== "all") return { ok: false, reason: "changed" };
  const skill = held.improved
    ? await saveSkill({ ...current, instructions: held.improved.instructions, start_url: held.improved.start_url ?? current.start_url, lessons: [] }, reserved)
    : held.lesson
      ? await addSkillLesson(current.id, held.lesson)
      : current;
  return skill ? { ok: true, skill } : { ok: false, reason: "gone" };
}

/**
 * The person chose to keep the refinement in this Space only: a copy of the
 * shared Skill for this Space, with it. Only while the Skill still exists and
 * is still shared with this Space.
 */
export async function keepRefinementInSpace(held: HeldRefinement, reserved: string[] = []): Promise<RefinementResult> {
  const current = (await loadAllSkills()).find((skill) => skill.id === held.skillId);
  if (!current) return { ok: false, reason: "gone" };
  if (current.visibility !== "all") return { ok: false, reason: "changed" };
  const copy = await copySkillToSpace(held.skillId, held.spaceId, held.spaceId, reserved);
  if (!copy) return { ok: false, reason: "changed" };
  const skill = held.improved
    ? await saveSkill({ ...copy, instructions: held.improved.instructions, start_url: held.improved.start_url ?? copy.start_url, lessons: [] }, reserved)
    : held.lesson
      ? await addSkillLesson(copy.id, held.lesson)
      : copy;
  return skill ? { ok: true, skill } : { ok: false, reason: "gone" };
}
