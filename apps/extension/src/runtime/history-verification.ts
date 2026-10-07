// A past answer remembered with what its verifier concluded (Memory v2 Phase 8).
//
// A browser task saves its final answer to task history and its evidence to a
// task episode. The answer is the parent model's own words; if a verifier
// contradicted what it was based on, those words must never come back later as
// remembered truth. A history entry links to its episode by `session_id`, and
// every recall path (the Context Compiler and /recall) reads the episode's
// verdicts through here. The episode stays the one record of the evidence;
// nothing about it is copied into history.
//
// The visible chat is never rewritten; this only governs what is used as memory.
import type { TaskHistoryEntry } from "./history";
import { episodesForSessions, type TaskEpisodeMemory } from "./task-memory";
import { verificationSummary } from "./task-provenance";

export type HistoryCheck = "contradicted" | "insufficient" | "supported";

export interface HistoryVerification {
  /** The weakest result over every verifier the task ran. */
  state: HistoryCheck;
  /** A few plain lines on what was checked and concluded. */
  lines: string[];
}

/** A history entry as recalled, with its episode's verification when it has one (never stored). */
export type RecalledHistoryEntry = TaskHistoryEntry & { verification?: HistoryVerification };

/**
 * What a task's verifiers concluded, overall. Any contradiction wins; any
 * check that was inconclusive, failed, blocked or cancelled makes it
 * unverified; only when every check supported it is it supported. A task
 * whose helpers had no verifier has none.
 */
export function verificationOfEpisode(episode: TaskEpisodeMemory | undefined): HistoryVerification | undefined {
  const verifiers = (episode?.dag_runs ?? []).flatMap((run) => run.nodes.filter((node) => node.type === "verify"));
  if (!verifiers.length) return undefined;
  const state: HistoryCheck = verifiers.some((node) => node.verdict === "contradicted")
    ? "contradicted"
    : verifiers.every((node) => node.status === "completed" && node.verdict === "supported")
      ? "supported"
      : "insufficient";
  return { state, lines: verificationSummary(episode!.dag_runs, 3) };
}

/** Adds each linked episode's verification. Episodes are read in this Space only; unlinked entries are unchanged. */
export async function withVerification(entries: TaskHistoryEntry[], spaceId?: string): Promise<RecalledHistoryEntry[]> {
  const sessions = entries.map((entry) => entry.session_id ?? "").filter(Boolean);
  if (!sessions.length) return entries;
  const episodes = await episodesForSessions(sessions, spaceId);
  return entries.map((entry) => {
    const verification = entry.session_id ? verificationOfEpisode(episodes.get(entry.session_id)) : undefined;
    return verification ? { ...entry, verification } : entry;
  });
}

function clip(text: string, max: number): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export const CONTRADICTED_ANSWER =
  "(the answer given then is left out: a verifier CONTRADICTED what it was based on, so don't treat it as true)";

/**
 * A past answer as memory. Contradicted: the old answer is not supplied at
 * all. Inconclusive: supplied, marked unverified. Supported: supplied,
 * marked as true at that time. No verifier: as before.
 */
export function rememberedAnswer(entry: RecalledHistoryEntry, max: number): string {
  const state = entry.verification?.state;
  if (state === "contradicted") return CONTRADICTED_ANSWER;
  const answer = clip(entry.result, max);
  if (state === "insufficient") return `${answer} [UNVERIFIED: the check was inconclusive, so don't treat this as established]`;
  if (state === "supported") return `${answer} [supported by the sources checked at that time; may have changed]`;
  return answer;
}

/** The verifier lines to show under a past answer, if any. */
export function verificationNotes(entry: RecalledHistoryEntry): string[] {
  return entry.verification?.lines ?? [];
}
