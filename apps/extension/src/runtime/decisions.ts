// Decisions: choices the person made for their work ("we keep code on GitHub"),
// separate from facts about them and from standing wishes. A new decision on
// the same subject replaces the old one, which is kept as history (so "what
// did we use before?" still has an answer) and never shown as current.
//
// Decisions belong to the Space they were made in and stay behind its wall
// (memory-scope.ts). One for every Space is only made when the person says so.
import { resolveSpace, visibleInSpace, type SpaceTagged } from "./memory-scope";
import { asksAboutThePast, isStorableFact, relevance, type Provenance } from "./about-me";
import { SPACE_TAGGED_KEYS } from "./spaces";

export type DecisionStatus = "current" | "superseded" | "reversed" | "historical";

export interface Decision extends SpaceTagged {
  id: string;
  type: "decision";
  /** What was decided about, like "Code home" or "Deployment platform". */
  subject: string;
  /** What was decided, like "GitHub". */
  value: string;
  rationale?: string;
  scope: "space" | "global";
  status: DecisionStatus;
  created_at: string;
  valid_from?: string;
  valid_until?: string;
  supersedes?: string;
  superseded_by?: string;
  provenance: Provenance;
}

const KEY = SPACE_TAGGED_KEYS.decisions;
const MAX_DECISIONS = 300;
const MAX_TEXT = 160;

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/[.,;:!]+$/, "").slice(0, MAX_TEXT);
}

/** Two subjects are the same when they only differ in case, "the/our/my" or spacing. */
export function subjectKey(subject: string): string {
  return clean(subject).toLowerCase().replace(/^(the|our|my) /, "");
}

async function loadAll(): Promise<Decision[]> {
  const value = (await chrome.storage.local.get(KEY))[KEY];
  return Array.isArray(value) ? (value as Decision[]) : [];
}

async function storeAll(decisions: Decision[]): Promise<void> {
  await chrome.storage.local.set({ [KEY]: decisions.slice(0, MAX_DECISIONS) });
}

function isCurrent(decision: Decision): boolean {
  return decision.status === "current";
}

/** Decisions at one level: this Space's own, or the ones for every Space. */
function atLevel(decision: Decision, scope: Decision["scope"], spaceId: string): boolean {
  return scope === "global" ? decision.visibility === "all" : decision.visibility !== "all" && (decision.space_id || "") === spaceId;
}

export interface DecisionInput {
  subject: string;
  value: string;
  rationale?: string;
  /** Every Space only when the person said so. */
  scope?: Decision["scope"];
  by?: Provenance["by"];
  chatId?: string;
}

/**
 * Records a decision. The current decision on the same subject at the same
 * level is kept as superseded, pointing at the new one. Saying the same thing
 * again changes nothing.
 */
export async function recordDecision(
  input: DecisionInput,
  spaceId?: string
): Promise<{ ok: true; decision: Decision; replaced?: Decision } | { ok: false; error: string }> {
  const subject = clean(input.subject).replace(/^./, (first) => first.toUpperCase());
  const value = clean(input.value);
  const rationale = input.rationale ? clean(input.rationale) : "";
  if (subject.length < 2 || !value) return { ok: false, error: "Say what it's about and what you chose, like “code home: GitHub”." };
  if (![subject, value, rationale].every((text) => !text || isStorableFact(text) || text.length < 3)) {
    return { ok: false, error: "That looks like a password, card or ID number, so I won't save it." };
  }
  const space = await resolveSpace(spaceId);
  const scope = input.scope ?? "space";
  const decisions = await loadAll();
  const key = subjectKey(subject);
  const old = decisions.find((item) => isCurrent(item) && atLevel(item, scope, space) && subjectKey(item.subject) === key);
  if (old && old.value.toLowerCase() === value.toLowerCase()) return { ok: true, decision: old };
  const now = new Date().toISOString();
  const decision: Decision = {
    id: crypto.randomUUID(),
    type: "decision",
    subject,
    value,
    ...(rationale ? { rationale } : {}),
    scope,
    status: "current",
    created_at: now,
    valid_from: now,
    ...(old ? { supersedes: old.id } : {}),
    space_id: space,
    visibility: scope === "global" ? "all" : "space",
    provenance: { by: input.by ?? "you", space_id: space, at: now, ...(input.chatId ? { chat_id: input.chatId } : {}) }
  };
  const next = decisions.map((item) =>
    item === old ? { ...item, status: "superseded" as const, valid_until: now, superseded_by: decision.id } : item
  );
  await storeAll([decision, ...next]);
  return old ? { ok: true, decision, replaced: { ...old, status: "superseded", valid_until: now, superseded_by: decision.id } } : { ok: true, decision };
}

/** Takes a decision back without a replacement: it is kept as reversed. */
export async function reverseDecision(id: string, spaceId?: string): Promise<boolean> {
  const space = await resolveSpace(spaceId);
  const decisions = await loadAll();
  const found = decisions.find((item) => item.id === id && isCurrent(item) && visibleInSpace(item, space));
  if (!found) return false;
  const now = new Date().toISOString();
  await storeAll(decisions.map((item) => (item === found ? { ...item, status: "reversed" as const, valid_until: now } : item)));
  return true;
}

/** Deletes one decision (any status) this Space can see. */
export async function removeDecision(id: string, spaceId?: string): Promise<boolean> {
  const space = await resolveSpace(spaceId);
  const decisions = await loadAll();
  const kept = decisions.filter((item) => !(item.id === id && visibleInSpace(item, space)));
  if (kept.length === decisions.length) return false;
  await storeAll(kept);
  return true;
}

/**
 * The decisions in force in this Space: its own, then the ones for every
 * Space. On the same subject, this Space's own wins.
 */
export async function currentDecisions(spaceId?: string): Promise<Decision[]> {
  const space = await resolveSpace(spaceId);
  const visible = (await loadAll()).filter((item) => isCurrent(item) && visibleInSpace(item, space));
  const own = visible.filter((item) => item.visibility !== "all");
  const subjects = new Set(own.map((item) => subjectKey(item.subject)));
  return [...own, ...visible.filter((item) => item.visibility === "all" && !subjects.has(subjectKey(item.subject)))];
}

/** Decisions no longer in force that this Space can see, newest first; optionally on one subject. */
export async function earlierDecisions(spaceId?: string, subject?: string): Promise<Decision[]> {
  const space = await resolveSpace(spaceId);
  const key = subject ? subjectKey(subject) : "";
  return (await loadAll())
    .filter((item) => !isCurrent(item) && visibleInSpace(item, space) && (!key || subjectKey(item.subject) === key))
    .sort((a, b) => (b.valid_until ?? "").localeCompare(a.valid_until ?? ""));
}

/** Earlier decisions that match a question about the past ("what did we use before GitHub?"). */
export async function earlierDecisionsFor(question: string, spaceId?: string): Promise<Decision[]> {
  if (!asksAboutThePast(question)) return [];
  const space = await resolveSpace(spaceId);
  const all = (await loadAll()).filter((item) => visibleInSpace(item, space));
  const earlier = all.filter((item) => !isCurrent(item));
  // "What decision did we replace?" asks about all of them; otherwise match the words.
  const general = /\b(decisions?|decided|choices?|chose)\b/i.test(question) ? 1 : 0;
  // A question naming today's choice ("before GitHub") also finds what it replaced.
  return earlier
    .map((item) => {
      const next = all.find((other) => other.id === item.superseded_by);
      const text = `${item.subject} ${item.value} ${next ? next.value : ""}`;
      return { item, score: relevance(question, text, subjectKey(item.subject)) + general };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || (b.item.valid_until ?? "").localeCompare(a.item.valid_until ?? ""))
    .slice(0, 5)
    .map((entry) => entry.item);
}

function line(decision: Decision): string {
  return `- ${decision.subject}: ${decision.value}${decision.rationale ? ` (because ${decision.rationale})` : ""}`;
}

/** The block for decisions in force. */
export function decisionsPrompt(decisions: Decision[]): string {
  if (!decisions.length) return "";
  return ["", "", "DECISIONS (choices I made that are in force now; follow them unless this request says otherwise):", ...decisions.slice(0, 20).map(line)].join(
    "\n"
  );
}

/** The block for older decisions, only added when the request asks about the past. */
export function earlierDecisionsPrompt(decisions: Decision[]): string {
  if (!decisions.length) return "";
  return [
    "",
    "",
    "EARLIER DECISIONS (no longer in force; use them only to answer questions about the past):",
    ...decisions.map((item) => `${line(item)}, ${item.status === "reversed" ? "taken back" : "replaced"} ${(item.valid_until ?? "").slice(0, 10)}`)
  ].join("\n");
}

/**
 * Reads "/decide code home: GitHub because …" (also "… is …"). "everywhere"
 * or "across all Spaces" at the start makes it a decision for every Space.
 */
export function parseDecision(args: string): DecisionInput | null {
  let text = args.trim();
  let scope: Decision["scope"] = "space";
  const every = /^(everywhere|(?:across|in|for) (?:all|every) (?:of )?(?:my )?spaces?)\b[\s,:]*/i.exec(text);
  if (every) {
    scope = "global";
    text = text.slice(every[0].length);
  }
  let rationale: string | undefined;
  const because = /\s+(?:because|since|as)\s+([\s\S]+)$/i.exec(text);
  if (because) {
    rationale = because[1];
    text = text.slice(0, because.index);
  }
  const split = /^(.{2,80}?)\s*(?::|=|\s+is\s+)\s*(.+)$/i.exec(text);
  if (!split) return null;
  return { subject: split[1], value: split[2], rationale, scope };
}

/** Carries out /decide and says what happened, in plain words. */
export async function decideCommand(args: string, spaceId?: string, chatId?: string): Promise<string> {
  const input = parseDecision(args);
  if (!input) return "Tell me what you decided, like `/decide code home: GitHub because it's where the team works`.";
  const result = await recordDecision({ ...input, by: "you", chatId }, spaceId);
  if (!result.ok) return result.error;
  const where = result.decision.scope === "global" ? " for every Space" : "";
  return result.replaced
    ? `Noted${where}: ${result.decision.subject} is now ${result.decision.value}. I'll keep “${result.replaced.value}” as what you used before.`
    : `Noted${where}: ${result.decision.subject} is ${result.decision.value}.`;
}

/** How many stored decisions sit behind the wall for this Space (counted by tag only). */
export async function countDecisionsOutsideSpace(spaceId?: string): Promise<number> {
  const space = await resolveSpace(spaceId);
  return (await loadAll()).filter((item) => !visibleInSpace(item, space)).length;
}

export const DECISIONS_STORAGE_KEY = KEY;
