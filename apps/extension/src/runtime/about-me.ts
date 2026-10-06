// "About me": a short list of facts about the person that the agent keeps in
// mind. They add facts themselves (/remember, the Memory screen) or it picks
// up plain statements from their requests ("my name is…", "I prefer…").
// Everything stays on this device and can be edited or deleted.

import { keyForSpace, spaceKey, SPACE_SCOPED_KEYS } from "./spaces";

export interface AboutMeFact {
  id: string;
  text: string;
  source: "you" | "learned";
  created_at: string;
  /** Facts about the same thing (where I live, my name) replace each other. */
  topic?: string;
}

// Each Space keeps its own facts (see spaces.ts).
const KEY = SPACE_SCOPED_KEYS.aboutMe;
const MAX_FACTS = 60;
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

/** The key for these facts: the given Space (a running task's), else the one in use. */
async function factsKey(spaceId?: string): Promise<string> {
  return spaceId ? keyForSpace(KEY, spaceId) : spaceKey(KEY);
}

export async function loadAboutMe(spaceId?: string): Promise<AboutMeFact[]> {
  const key = await factsKey(spaceId);
  const stored = await chrome.storage.local.get(key);
  const value = stored[key];
  return Array.isArray(value) ? (value as AboutMeFact[]) : [];
}

async function store(facts: AboutMeFact[], spaceId?: string): Promise<void> {
  await chrome.storage.local.set({ [await factsKey(spaceId)]: facts.slice(0, MAX_FACTS) });
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

/**
 * Adds facts that are new and safe to keep; a fact on the same topic as an
 * older one replaces it. Returns the ones added.
 */
export async function addFacts(texts: string[], source: AboutMeFact["source"], spaceId?: string): Promise<AboutMeFact[]> {
  let facts = await loadAboutMe(spaceId);
  const known = new Set(facts.map((fact) => fact.text.toLowerCase()));
  const added: AboutMeFact[] = [];
  for (const text of texts) {
    const value = clean(text);
    if (!isStorableFact(value) || known.has(value.toLowerCase())) continue;
    known.add(value.toLowerCase());
    const topic = factTopic(value);
    if (topic) facts = facts.filter((fact) => (fact.topic ?? factTopic(fact.text)) !== topic);
    added.push({
      id: crypto.randomUUID(),
      text: value,
      source,
      created_at: new Date().toISOString(),
      ...(topic ? { topic } : {})
    });
  }
  if (added.length) await store([...added, ...facts], spaceId);
  return added;
}

export async function updateFact(id: string, text: string): Promise<boolean> {
  const value = clean(text);
  if (!isStorableFact(value)) return false;
  const facts = await loadAboutMe();
  await store(facts.map((fact) => (fact.id === id ? { ...fact, text: value, source: "you" } : fact)));
  return true;
}

export async function removeFact(id: string): Promise<void> {
  await store((await loadAboutMe()).filter((fact) => fact.id !== id));
}

/** Removes every fact that mentions the words; returns how many. */
export async function forgetMatching(words: string): Promise<number> {
  const needle = words.trim().toLowerCase();
  if (!needle) return 0;
  const facts = await loadAboutMe();
  const kept = facts.filter((fact) => !fact.text.toLowerCase().includes(needle));
  await store(kept);
  return facts.length - kept.length;
}

export async function clearAboutMe(): Promise<void> {
  await chrome.storage.local.remove(await spaceKey(KEY));
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

export const ABOUT_ME_STORAGE_KEY = KEY;
