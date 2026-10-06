// "About me": a short list of facts about the person that the agent keeps in
// mind. They add facts themselves (/remember, the Memory screen) or it picks
// up plain statements from their requests ("my name is…", "I prefer…").
// Everything stays on this device and can be edited or deleted.
//
// Facts live at one of two levels: the Space they were said in (the default,
// and the narrowest) or every Space. Only who the person is (name, what to
// call them, where they live, their language) or something said "across all
// Spaces" goes to every Space; nothing else is promoted on its own.

import { resolveSpace } from "./memory-scope";
import { keyForSpace, loadSpaces, spaceKey, SPACE_SCOPED_KEYS } from "./spaces";

/** Where a remembered thing came from. Only what is actually known is filled in. */
export interface Provenance {
  /** "you": the person said to keep it (/remember, the About you screen). "learned": picked up from their own message. */
  by: "you" | "learned";
  /** The Space it was said in (for a fact kept for every Space, too). */
  space_id: string;
  at: string;
  /** The chat it was said in, when there was one. */
  chat_id?: string;
}

export type FactStatus = "current" | "superseded" | "historical";

export interface AboutMeFact {
  id: string;
  text: string;
  source: "you" | "learned";
  created_at: string;
  /** Facts about the same thing (where I live, my name) replace each other. */
  topic?: string;
  /** Missing on facts saved before old facts were kept: those are current. */
  status?: FactStatus;
  valid_from?: string;
  /** When it stopped being true (it was replaced). */
  valid_until?: string;
  /** The fact this one replaced, and the one that replaced it. */
  supersedes?: string;
  superseded_by?: string;
  /** Said for this Space on purpose ("In this Space I am based in Delhi"), so a fact for every Space never replaces it. */
  explicit_scope?: boolean;
  provenance?: Provenance;
}

// Each Space keeps its own facts (see spaces.ts); facts for every Space live apart.
const KEY = SPACE_SCOPED_KEYS.aboutMe;
const GLOBAL_KEY = "browserharness.aboutMe.global";

/** Where a fact applies: the Space it was said in, or every Space. */
export type FactScope = "space" | "global";
const MAX_FACTS = 60;
/** Older facts kept per level, newest first. */
const MAX_EARLIER = 100;
const MAX_FACT = 200;

/** Never stored, whoever asks. */
const SENSITIVE =
  /(password|passcode|passwd|otp|one[- ]time|\bpin\b|cvv|card number|credit card|debit card|ssn|social security|aadhaar|pan number|bank account|routing number|iban|api key|secret|token)|\d{6,}/i;

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/[.,;:!]+$/, "").slice(0, MAX_FACT);
}

export function isStorableFact(text: string): boolean {
  const value = clean(text);
  return value.length >= 3 && !SENSITIVE.test(value);
}

/** True while a fact is still true (facts saved before history was kept count as true). */
export function isCurrent(fact: { status?: string }): boolean {
  return !fact.status || fact.status === "current";
}

/** The key for these facts: every Space, the given Space (a running task's), or the one in use. */
async function factsKey(spaceId?: string, scope: FactScope = "space"): Promise<string> {
  if (scope === "global") return GLOBAL_KEY;
  return spaceId ? keyForSpace(KEY, spaceId) : spaceKey(KEY);
}

/** Every fact kept at one level, true now or not. */
async function loadAll(spaceId?: string, scope: FactScope = "space"): Promise<AboutMeFact[]> {
  const key = await factsKey(spaceId, scope);
  const value = (await chrome.storage.local.get(key))[key];
  return Array.isArray(value) ? (value as AboutMeFact[]) : [];
}

/** This Space's own facts that are true now. */
export async function loadAboutMe(spaceId?: string): Promise<AboutMeFact[]> {
  return (await loadAll(spaceId)).filter(isCurrent);
}

/** Facts that go with every Space and are true now. */
export async function loadGlobalAboutMe(): Promise<AboutMeFact[]> {
  return (await loadAll(undefined, "global")).filter(isCurrent);
}

/** Facts at one level that are no longer true (replaced by a newer one), newest first. */
export async function loadEarlierFacts(spaceId?: string, scope: FactScope = "space"): Promise<AboutMeFact[]> {
  return (await loadAll(spaceId, scope)).filter((fact) => !isCurrent(fact));
}

/** Keeps the facts at one level: up to MAX_FACTS true now, and the newest older ones. */
async function store(facts: AboutMeFact[], spaceId?: string, scope: FactScope = "space"): Promise<void> {
  const current = facts.filter(isCurrent).slice(0, MAX_FACTS);
  const earlier = facts.filter((fact) => !isCurrent(fact)).slice(0, MAX_EARLIER);
  await chrome.storage.local.set({ [await factsKey(spaceId, scope)]: [...current, ...earlier] });
}

function topicOf(fact: AboutMeFact): string | undefined {
  return fact.topic ?? factTopic(fact.text);
}

/** Marks a fact as no longer true, keeping it and saying what replaced it. */
function supersede(fact: AboutMeFact, by: AboutMeFact): AboutMeFact {
  return { ...fact, status: "superseded", valid_until: by.created_at, superseded_by: by.id };
}

/**
 * What a fact is about, when only one such fact can be true at a time:
 * "I live in Mumbai" replaces "I live in Pune".
 */
export function factTopic(text: string): string | undefined {
  const value = text.toLowerCase();
  if (/^my name is\b/.test(value)) return "name";
  if (/^i like to be called\b/.test(value)) return "nickname";
  if (/^i (live|am based|'m based) in\b/.test(value)) return "home";
  if (/^i work (at|for)\b/.test(value)) return "work";
  const favourite = /^my favou?rite ([a-z ]{2,30}) is\b/.exec(value);
  if (favourite) return `favourite:${favourite[1].trim()}`;
  const setting = /^my (currency|budget|timezone|time zone|language) is\b/.exec(value);
  if (setting) return setting[1].replace(" ", "");
  return undefined;
}

export interface AddFactOptions {
  /** Said for this Space on purpose; see AboutMeFact.explicit_scope. */
  explicit?: boolean;
  chatId?: string;
}

/**
 * Adds facts that are new and safe to keep, to this Space (default) or to
 * every Space. A fact on the same topic as an older one at the same level
 * replaces it; the older one is kept as no longer true, never deleted.
 *
 * A fact for every Space also replaces the same topic in the Space it was
 * said in, and, for who the person is (name, home, language), in every other
 * Space, so an older, narrower fact can't hide it. A fact said for one Space
 * on purpose ("In this Space I am based in Delhi") stays as that Space's own.
 * Returns the ones added.
 */
export async function addFacts(
  texts: string[],
  source: AboutMeFact["source"],
  spaceId?: string,
  scope: FactScope = "space",
  options: AddFactOptions = {}
): Promise<AboutMeFact[]> {
  const saidIn = await resolveSpace(spaceId);
  let facts = await loadAll(spaceId, scope);
  const known = new Set(facts.filter(isCurrent).map((fact) => fact.text.toLowerCase()));
  const added: AboutMeFact[] = [];
  for (const text of texts) {
    const value = clean(text);
    if (!isStorableFact(value) || known.has(value.toLowerCase())) continue;
    known.add(value.toLowerCase());
    const topic = factTopic(value);
    const now = new Date().toISOString();
    const fact: AboutMeFact = {
      id: crypto.randomUUID(),
      text: value,
      source,
      created_at: now,
      ...(topic ? { topic } : {}),
      status: "current",
      valid_from: now,
      ...(scope === "space" && options.explicit ? { explicit_scope: true } : {}),
      provenance: { by: source, space_id: saidIn, at: now, ...(options.chatId ? { chat_id: options.chatId } : {}) }
    };
    const replaced = topic ? facts.find((item) => isCurrent(item) && topicOf(item) === topic) : undefined;
    if (replaced) {
      fact.supersedes = replaced.id;
      facts = facts.map((item) => (isCurrent(item) && topicOf(item) === topic ? supersede(item, fact) : item));
    }
    added.push(fact);
  }
  if (added.length) await store([...added, ...facts], spaceId, scope);
  if (added.length && scope === "global") await supersedeNarrower(added, saidIn);
  return added;
}

/** Who the person is: true in every part of their life. */
const IDENTITY_TOPICS = new Set(["name", "nickname", "home", "language"]);

/**
 * After facts for every Space arrive: older Space facts on the same topic,
 * not said for their Space on purpose, are kept as no longer true. In the
 * Space it was said in that is any topic; in other Spaces only who the person
 * is, since only that was ever kept apart by accident (before every-Space
 * facts existed).
 */
async function supersedeNarrower(added: AboutMeFact[], saidIn: string): Promise<void> {
  const byTopic = new Map(added.filter((fact) => fact.topic).map((fact) => [fact.topic as string, fact]));
  if (!byTopic.size) return;
  const { spaces } = await loadSpaces();
  const ids = new Set([saidIn, ...spaces.map((space) => space.id)]);
  for (const id of ids) {
    const facts = await loadAll(id);
    let changed = false;
    const next = facts.map((fact) => {
      const topic = topicOf(fact);
      const by = topic ? byTopic.get(topic) : undefined;
      if (!by || !isCurrent(fact) || fact.explicit_scope) return fact;
      if (id !== saidIn && !IDENTITY_TOPICS.has(topic as string)) return fact;
      changed = true;
      return supersede(fact, by);
    });
    if (changed) await store(next, id);
  }
}

/** Adds facts each at its own level (see factScopeIn); returns the ones added, with their level. */
export async function rememberFacts(
  items: Array<{ text: string; scope: FactScope; explicit?: boolean }>,
  source: AboutMeFact["source"],
  spaceId?: string,
  chatId?: string
): Promise<Array<AboutMeFact & { scope: FactScope }>> {
  const added: Array<AboutMeFact & { scope: FactScope }> = [];
  for (const scope of ["global", "space"] as const) {
    for (const explicit of [false, true]) {
      const texts = items.filter((item) => item.scope === scope && Boolean(item.explicit) === explicit).map((item) => item.text);
      if (!texts.length) continue;
      const facts = await addFacts(texts, source, spaceId, scope, { explicit, chatId });
      added.push(...facts.map((fact) => ({ ...fact, scope })));
    }
  }
  return added;
}

/** Moves a fact between this Space and every Space (moving it to this Space is choosing it for this Space). */
export async function moveFact(id: string, to: FactScope, spaceId?: string): Promise<boolean> {
  const from: FactScope = to === "global" ? "space" : "global";
  const source = await loadAll(spaceId, from);
  const fact = source.find((item) => item.id === id && isCurrent(item));
  if (!fact) return false;
  await store(source.filter((item) => item.id !== id), spaceId, from);
  await addFacts([fact.text], fact.source, spaceId, to, { explicit: to === "space" });
  return true;
}

/** Corrects a fact's wording (a typo, not a change in life): it stays one fact. */
export async function updateFact(id: string, text: string, scope: FactScope = "space"): Promise<boolean> {
  const value = clean(text);
  if (!isStorableFact(value)) return false;
  const facts = await loadAll(undefined, scope);
  await store(facts.map((fact) => (fact.id === id ? { ...fact, text: value, source: "you" } : fact)), undefined, scope);
  return true;
}

/** Deletes one fact, true now or older, at the level it is shown. */
export async function removeFact(id: string, scope: FactScope = "space"): Promise<void> {
  const facts = await loadAll(undefined, scope);
  await store(facts.filter((fact) => fact.id !== id), undefined, scope);
}

/**
 * Removes the facts that mention the words at one level, older ones too:
 * this Space (the default, so a normal /forget never changes what other
 * Spaces know) or every Space. Returns how many went.
 */
export async function forgetMatching(words: string, spaceId?: string, scope: FactScope = "space"): Promise<number> {
  const needle = words.trim().toLowerCase();
  if (!needle) return 0;
  const facts = await loadAll(spaceId, scope);
  const kept = facts.filter((fact) => !fact.text.toLowerCase().includes(needle));
  if (kept.length !== facts.length) await store(kept, spaceId, scope);
  return facts.length - kept.length;
}

/** "/forget everywhere tea" or "/forget across all Spaces tea": the words, and whether it means every Space. */
export function parseForget(args: string): { words: string; scope: FactScope } {
  const match = /^\s*(everywhere|(?:across|in|from) (?:all|every) (?:of )?(?:my )?spaces?)\b[\s,:]*/i.exec(args);
  return match ? { words: args.slice(match[0].length).trim(), scope: "global" } : { words: args.trim(), scope: "space" };
}

/** Carries out /forget and says what happened, in plain words. */
export async function forgetCommand(args: string, spaceId?: string): Promise<string> {
  const { words, scope } = parseForget(args);
  if (!words) return "Tell me what to forget, like `/forget aisle seats`, or `/forget everywhere aisle seats` for every Space.";
  const removed = await forgetMatching(words, spaceId, scope);
  const plural = removed === 1 ? "" : "s";
  if (scope === "global") {
    return removed
      ? `Forgot ${removed} fact${plural} about “${words}” in every Space.`
      : `Nothing about “${words}” is remembered in every Space.`;
  }
  if (removed) return `Forgot ${removed} fact${plural} about “${words}”.`;
  const needle = words.toLowerCase();
  const shared = (await loadGlobalAboutMe()).filter((fact) => fact.text.toLowerCase().includes(needle));
  if (shared.length) {
    return `I didn't forget it: “${shared[0].text}” is remembered in every Space, not just this one. To forget it everywhere, type \`/forget everywhere ${words}\`, or remove it on the About you screen.`;
  }
  return `I had nothing saved about “${words}”.`;
}

/** Forgets this Space's own facts; the facts for every Space stay. */
export async function clearAboutMe(): Promise<void> {
  await chrome.storage.local.remove(await spaceKey(KEY));
}

export async function clearGlobalAboutMe(): Promise<void> {
  await chrome.storage.local.remove(GLOBAL_KEY);
}

/** Said for every Space on purpose. */
const EVERY_SPACE =
  /\b(across|in|for) (all|every) (my |of my )?spaces?\b|\bin every space\b|\beverywhere\b|\bwherever i am\b|\bgenerally\b|\bin general\b|\bglobally\b|\bin all my (chats|work)\b/i;
/** Said for this Space only. */
const THIS_SPACE = /\b(for|in) this (space|project|work|client|shop|store|team|account)\b|\bhere only\b|\bonly here\b/i;

/**
 * The level a fact belongs at, from the fact and the words it came with.
 * When in doubt, this Space: the narrowest level that fits.
 */
export function factScopeIn(fact: string, said = ""): FactScope {
  const context = `${said} ${fact}`;
  if (THIS_SPACE.test(context)) return "space";
  if (EVERY_SPACE.test(context)) return "global";
  const topic = factTopic(clean(fact));
  return topic && IDENTITY_TOPICS.has(topic) ? "global" : "space";
}

/** True when the words keep a fact to this Space on purpose ("For this project…", "In this Space…"). */
export function saidForThisSpace(fact: string, said = ""): boolean {
  return THIS_SPACE.test(`${said} ${fact}`);
}

/** Removes "across all Spaces," / "in this Space," and the like from a fact, keeping what it says. */
export function withoutScopeWords(text: string): string {
  return clean(
    text
      .replace(/^\s*(across|in|for) (all|every) (my |of my )?spaces?,?\s*/i, "")
      .replace(/,?\s*(across|in|for) (all|every) (my |of my )?spaces?\b/i, "")
      .replace(/^\s*(for|in) this (space|project),?\s*/i, "")
  ).replace(/^./, (first) => first.toUpperCase());
}

const PATTERNS: Array<[RegExp, (match: RegExpExecArray) => string]> = [
  [/\bmy name is ([\p{L}][\p{L}'’ -]{0,40}?)(?=[,.;!?]|\band\b|\bbut\b|$)/iu, (m) => `My name is ${m[1]}`],
  [/\bcall me ([\p{L}][\p{L}'’ -]{0,30}?)(?=[,.;!?]|\band\b|\bbut\b|$)/iu, (m) => `I like to be called ${m[1]}`],
  [/\bi live in ([\p{L}][\p{L}0-9'’ ,-]{1,50}?)(?=[.;!?]|\band\b|\bbut\b|$)/iu, (m) => `I live in ${m[1].replace(/\s+(now|these days)$/i, "")}`],
  [/\bi(?:'m| am) based in ([\p{L}][\p{L}'’ ,-]{1,50}?)(?=[.;!?]|\band\b|\bbut\b|$)/iu, (m) => `I live in ${m[1]}`],
  [/\bi (?:usually |always )?prefer ([^.;!?\n]{3,100})/iu, (m) => `I prefer ${m[1]}`],
  [/\bi always ([^.;!?\n]{3,100})/iu, (m) => `I always ${m[1]}`],
  [/\bi never ([^.;!?\n]{3,100})/iu, (m) => `I never ${m[1]}`],
  [/\bmy (?:favou?rite|preferred) ([\p{L} ]{2,30}) is ([^.;!?\n]{2,60})/iu, (m) => `My favourite ${m[1]} is ${m[2]}`],
  [/\bmy (?:currency|budget|timezone|time zone|language) is ([^.;!?\n]{2,40})/iu, (m) => m[0].replace(/^my/i, "My")],
  [/^\s*(?:across|in|for) (?:all|every) (?:of )?(?:my )?spaces?,?\s+([^?\n]{3,160})/iu, (m) => m[1].replace(/^./, (first) => first.toUpperCase())],
  [/\bremember (?:that |: ?)([^?\n]{3,180})/iu, (m) => m[1]],
  [/\bremember (my [^?\n]{3,180})/iu, (m) => m[1].replace(/^my/, "My")]
];

/** Plain statements about the person in a request, worth remembering. */
export function factsInMessage(text: string): string[] {
  const found: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    for (const [pattern, render] of PATTERNS) {
      const match = pattern.exec(sentence);
      if (!match) continue;
      const fact = clean(render(match));
      if (isStorableFact(fact) && !found.includes(fact)) found.push(fact);
    }
  }
  return found.slice(0, 5);
}

/** The facts in a message, each with the level it belongs at (see factScopeIn). */
export function scopedFactsInMessage(text: string): Array<{ text: string; scope: FactScope; explicit?: boolean }> {
  const found: Array<{ text: string; scope: FactScope; explicit?: boolean }> = [];
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    for (const [pattern, render] of PATTERNS) {
      const match = pattern.exec(sentence);
      if (!match) continue;
      const fact = withoutScopeWords(render(match));
      if (isStorableFact(fact) && !found.some((item) => item.text === fact)) found.push({ text: fact, scope: factScopeIn(fact, sentence), ...(saidForThisSpace(fact, sentence) ? { explicit: true } : {}) });
    }
  }
  return found.slice(0, 5);
}

/** Messages that may say something lasting about the person, worth a closer look. */
export function mightStateFacts(text: string): boolean {
  return /\b(i am|i'm|i work|i have|i use|i like|i love|i hate|i don't|i do not|i moved|i live|i usually|i own|i drive|i speak|i study|my (wife|husband|partner|son|daughter|kids?|children|family|company|team|job|office|home|car|budget|size|birthday)|we are|we're|we live|our (company|team|family|home))\b/i.test(
    text
  );
}

const EXTRACT_MARKER = "EXTRACT_FACTS";

/** Asks the model for lasting facts in a message, as first-person sentences. */
export function factExtractionPrompt(message: string, known: AboutMeFact[]): string {
  return [
    EXTRACT_MARKER,
    "From the person's message below, list lasting facts about them that would help an assistant later: name, where they live, where they work, family, preferences, tools and sites they use, regular plans.",
    "Write each as a short first-person sentence, like “I live in Mumbai” or “I prefer aisle seats”.",
    "Skip anything temporary or about this one request. Never include passwords, card, account or ID numbers, or anything secret.",
    known.length ? `Already known (do not repeat): ${known.slice(0, 30).map((fact) => fact.text).join("; ")}` : "",
    "Reply with only a JSON array of strings, or [] if there is nothing lasting.",
    "",
    "MESSAGE:",
    message.slice(0, 2000)
  ]
    .filter(Boolean)
    .join("\n");
}

/** The facts in the model's reply, keeping only safe, short sentences. */
export function parseExtractedFacts(reply: string): string[] {
  const match = /\[[\s\S]*\]/.exec(reply);
  if (!match) return [];
  try {
    const value = JSON.parse(match[0]);
    if (!Array.isArray(value)) return [];
    return value
      .filter((item): item is string => typeof item === "string")
      .map(clean)
      .filter((fact) => isStorableFact(fact) && fact.length <= MAX_FACT)
      .slice(0, 5);
  } catch {
    return [];
  }
}

/**
 * What the agent should know about the person in this Space: this Space's
 * facts, then the facts for every Space. On the same topic, this Space's own
 * fact wins (it is the narrower, more specific one).
 */
export function aboutMeFor(globalFacts: AboutMeFact[], spaceFacts: AboutMeFact[]): AboutMeFact[] {
  globalFacts = globalFacts.filter(isCurrent);
  spaceFacts = spaceFacts.filter(isCurrent);
  const local = new Set(spaceFacts.map((fact) => fact.topic ?? factTopic(fact.text)).filter(Boolean));
  const seen = new Set(spaceFacts.map((fact) => fact.text.toLowerCase()));
  return [
    ...spaceFacts,
    ...globalFacts.filter((fact) => {
      const topic = fact.topic ?? factTopic(fact.text);
      return !(topic && local.has(topic)) && !seen.has(fact.text.toLowerCase());
    })
  ];
}

/** The block added to every request so the agent knows the person. */
export function aboutMePrompt(facts: AboutMeFact[]): string {
  if (!facts.length) return "";
  return [
    "",
    "",
    "ABOUT ME (facts I saved; use them when they help with this request, never share them with websites unless the request needs it):",
    ...facts.slice(0, 30).map((fact) => `- ${fact.text}`)
  ].join("\n");
}

/** A question about how things were before ("Where did I live before Mumbai?"). */
export function asksAboutThePast(question: string): boolean {
  return /\b(before|previous(ly)?|used to|earlier|former(ly)?|old|last (one|time)|originally|at first|did i (say|tell|live|use)|what did we|replaced?|changed? from|switched from)\b/i.test(question);
}

const TOPIC_WORDS: Record<string, string[]> = {
  name: ["name"],
  nickname: ["call", "called", "nickname"],
  home: ["live", "lived", "living", "city", "town", "home", "based", "moved", "move"],
  work: ["work", "worked", "job", "company", "employer", "office"],
  currency: ["currency", "money", "price", "prices"],
  language: ["language", "speak"],
  timezone: ["timezone", "time zone"],
  budget: ["budget"]
};

const STOP = new Set(["the", "and", "did", "what", "where", "which", "was", "were", "you", "your", "that", "this", "with", "for", "before", "previously", "used", "earlier", "say", "said", "tell", "told"]);

/** How well a question and a remembered line match: shared words, plus topic words ("live" for a home). */
export function relevance(question: string, text: string, topic?: string): number {
  const words = new Set(question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)?.filter((word) => !STOP.has(word)) ?? []);
  let score = 0;
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) if (words.has(word) && !STOP.has(word)) score += 1;
  const base = topic?.replace(/^favourite:/, "");
  for (const word of (base && TOPIC_WORDS[base]) || (base ? [base] : [])) if (words.has(word)) score += 2;
  return score;
}

/**
 * Facts that were true before and match a question about the past, from this
 * Space and every Space, newest first. Nothing for an ordinary request, so
 * old facts never reach the agent as if they were still true.
 */
export async function earlierFactsFor(question: string, spaceId?: string): Promise<AboutMeFact[]> {
  if (!asksAboutThePast(question)) return [];
  const earlier = [...(await loadEarlierFacts(spaceId)), ...(await loadEarlierFacts(undefined, "global"))];
  return earlier
    .map((fact) => ({ fact, score: relevance(question, fact.text, topicOf(fact)) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || (b.fact.valid_until ?? "").localeCompare(a.fact.valid_until ?? ""))
    .slice(0, 5)
    .map((item) => item.fact);
}

/** The block for older facts, only added when the request asks about the past. */
export function earlierFactsPrompt(facts: AboutMeFact[]): string {
  if (!facts.length) return "";
  return [
    "",
    "",
    "NO LONGER TRUE (things I said before that were later replaced; use them only to answer questions about the past, never as how things are now):",
    ...facts.map((fact) => `- ${fact.text} (until ${(fact.valid_until ?? "").slice(0, 10) || "later"})`)
  ].join("\n");
}

export const ABOUT_ME_STORAGE_KEY = KEY;
export const GLOBAL_ABOUT_ME_STORAGE_KEY = GLOBAL_KEY;
