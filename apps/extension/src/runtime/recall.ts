// Remembering past conversations: when a request refers back ("what did I
// find last week about kettles?") or closely matches earlier work, the best
// matching history entries go to the model as context, and it answers from
// them. /recall lists them without a model.
import { loadTaskHistory, type TaskHistoryEntry } from "./history";
import { rememberedAnswer, verificationNotes, withVerification, type RecalledHistoryEntry } from "./history-verification";
import { contentWords } from "./skill-learning";

const MAX_RECALLED = 5;
const MAX_RESULT_CHARS = 400;
const DAY_MS = 86_400_000;

/** Requests that point at earlier conversations. */
const LOOKS_BACK =
  /\b(last (time|week|month|night|year)|yesterday|earlier|before|previous(ly)?|again|remind me|what did (i|we|you)|did (i|we|you) (ever|already)|have (i|we) (ever|already)|which .{1,40} did (i|we)|when did (i|we)|as (i|we) (did|discussed)|like (last|before))\b/i;

export function looksBack(text: string): boolean {
  return LOOKS_BACK.test(text);
}

/** Words that say "earlier", not what about. */
const TIME_WORDS = new Set(
  "which what did last week month year yesterday today earlier before previous previously again remind ever already time same about find found get got pick picked chose choose we you like there".split(" ")
);

/** How well a past entry fits the request, 0 to 1, a little higher when recent. */
export function recallScore(entry: TaskHistoryEntry, query: string, now = Date.now(), minShared = 1): number {
  const asked = new Set([...contentWords(query)].filter((word) => !TIME_WORDS.has(word)));
  if (!asked.size) return 0;
  const known = contentWords(`${entry.task} ${entry.result} ${entry.url || ""}`);
  let shared = 0;
  for (const word of asked) if (known.has(word)) shared += 1;
  if (!shared || shared < minShared) return 0;
  const coverage = shared / asked.size;
  const age = Math.max(0, now - Date.parse(entry.timestamp)) / DAY_MS;
  const freshness = Number.isFinite(age) ? 0.1 * Math.exp(-age / 30) : 0;
  return Math.min(1, coverage + freshness);
}

/** The best matching past entries, best first. */
export function recallHistory(
  entries: TaskHistoryEntry[],
  query: string,
  { minScore = 0.34, limit = MAX_RECALLED, now = Date.now(), minShared = 1 } = {}
): TaskHistoryEntry[] {
  return entries
    .map((entry) => ({ entry, score: recallScore(entry, query, now, minShared) }))
    .filter((item) => item.score >= minScore)
    .sort((a, b) => b.score - a.score || b.entry.timestamp.localeCompare(a.entry.timestamp))
    .slice(0, limit)
    .map((item) => item.entry);
}

function clip(text: string, max: number): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function day(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "earlier" : date.toISOString().slice(0, 10);
}

/** The context block for the model. */
export function recallPrompt(entries: RecalledHistoryEntry[]): string {
  if (!entries.length) return "";
  return [
    "",
    "",
    "FROM OUR PAST CONVERSATIONS (saved on this device; use them when the request refers to earlier work, and say when something may be out of date):",
    ...entries.map(
      (entry) =>
        `- ${day(entry.timestamp)}: I asked “${clip(entry.task, 160)}” → ${rememberedAnswer(entry, MAX_RESULT_CHARS)}${entry.url ? ` (${entry.url})` : ""}${verificationNotes(entry).map((line) => `\n  ${line}`).join("")}`
    )
  ].join("\n");
}

/**
 * What to add for a request: the matches when it looks back, or only very
 * close matches otherwise, so unrelated history never crowds the prompt.
 */
export function recallFor(entries: TaskHistoryEntry[], request: string, now = Date.now()): TaskHistoryEntry[] {
  return looksBack(request)
    ? recallHistory(entries, request, { now })
    : recallHistory(entries, request, { minScore: 0.75, limit: 2, now, minShared: 3 });
}

/**
 * The chat answer for /recall: plain matches, newest first, no model. Pass
 * entries through `withVerification` first (as `recallCommand` does) so an
 * answer a verifier contradicted is never repeated as it was.
 */
export function recallAnswer(entries: RecalledHistoryEntry[], query: string): string {
  if (!query.trim()) return "Tell me what to look for, like `/recall kettle prices`.";
  const found = recallHistory(entries, query, { minScore: 0.5, limit: 8 }).sort((a, b) =>
    b.timestamp.localeCompare(a.timestamp)
  );
  if (!found.length) return `I found nothing about “${query.trim()}” in your past conversations.`;
  return [
    `From your past conversations about “${query.trim()}”:`,
    "",
    ...found.map(
      (entry) =>
        `- **${day(entry.timestamp)}**: ${clip(entry.task, 120)} → ${rememberedAnswer(entry, 240)}${verificationNotes(entry).map((line) => `\n  - ${line}`).join("")}`
    )
  ].join("\n");
}

/** /recall in a Space: its history, each answer with what its task's verifier concluded. */
export async function recallCommand(query: string, spaceId?: string): Promise<string> {
  const entries = await loadTaskHistory(spaceId).catch(() => []);
  const found = recallHistory(entries, query, { minScore: 0.5, limit: 8 });
  const checked = await withVerification(found, spaceId).catch(() => found);
  return recallAnswer(checked, query);
}
