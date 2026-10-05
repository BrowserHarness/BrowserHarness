// "About me": a short list of facts about the person that the agent keeps in
// mind. They add facts themselves (/remember, the Memory screen) or it picks
// up plain statements from their requests ("my name is…", "I prefer…").
// Everything stays on this device and can be edited or deleted.

export interface AboutMeFact {
  id: string;
  text: string;
  source: "you" | "learned";
  created_at: string;
}

const KEY = "browserharness.aboutMe";
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

export async function loadAboutMe(): Promise<AboutMeFact[]> {
  const stored = await chrome.storage.local.get(KEY);
  const value = stored[KEY];
  return Array.isArray(value) ? (value as AboutMeFact[]) : [];
}

async function store(facts: AboutMeFact[]): Promise<void> {
  await chrome.storage.local.set({ [KEY]: facts.slice(0, MAX_FACTS) });
}

/** Adds facts that are new and safe to keep; returns the ones added. */
export async function addFacts(texts: string[], source: AboutMeFact["source"]): Promise<AboutMeFact[]> {
  const facts = await loadAboutMe();
  const known = new Set(facts.map((fact) => fact.text.toLowerCase()));
  const added: AboutMeFact[] = [];
  for (const text of texts) {
    const value = clean(text);
    if (!isStorableFact(value) || known.has(value.toLowerCase())) continue;
    known.add(value.toLowerCase());
    added.push({ id: crypto.randomUUID(), text: value, source, created_at: new Date().toISOString() });
  }
  if (added.length) await store([...added, ...facts]);
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
  await chrome.storage.local.remove(KEY);
}

const PATTERNS: Array<[RegExp, (match: RegExpExecArray) => string]> = [
  [/\bmy name is ([\p{L}][\p{L}'’ -]{0,40}?)(?=[,.;!?]|\band\b|\bbut\b|$)/iu, (m) => `My name is ${m[1]}`],
  [/\bcall me ([\p{L}][\p{L}'’ -]{0,30}?)(?=[,.;!?]|\band\b|\bbut\b|$)/iu, (m) => `I like to be called ${m[1]}`],
  [/\bi live in ([\p{L}][\p{L}0-9'’ ,-]{1,50}?)(?=[.;!?]|\band\b|\bbut\b|$)/iu, (m) => `I live in ${m[1]}`],
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
