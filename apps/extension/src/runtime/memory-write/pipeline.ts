// The Memory Write Pipeline: the one place that decides whether something is
// remembered, as what, where, and what it does to what is already known.
//
//   candidate → source/trust → sensitivity → classification → scope
//     → dedupe/relationship → confidence → action → write
//
// The Context Compiler is the read side ("send only what helps"); this is the
// write side: remember only what is durable, grounded in the person's own
// words, safe, correctly scoped and worth using again. Replacement over time
// is left to the existing stores (addFacts by topic, recordDecision by
// subject), so Phase 4's history keeps working unchanged.
import { factScopeIn, factTopic, saidForThisSpace, type AboutMeFact, type FactScope } from "../about-me";
import { subjectKey } from "../decisions";
import { contentWords } from "../skill-learning";
import { selfAssertedText } from "./assertion";
import { certaintyOf, classifyStatement } from "./classify";
import { recordWriteDiagnostics } from "./diagnostics";
import { checkSensitive } from "./sensitivity";
import {
  trustOf,
  type Certainty,
  type Classification,
  type MemoryCandidate,
  type MemoryType,
  type MemoryWriteResult,
  type Relationship
} from "./types";
import { localMemoryWriter, type MemoryWriter } from "./writer";

/** Below this, a memory picked up on its own is not kept. */
export const AUTO_WRITE_CONFIDENCE = 0.7;

const clean = (text: string) => text.replace(/\s+/g, " ").trim().replace(/[.,;:!]+$/, "").slice(0, 200);
const capital = (text: string) => text.replace(/^./, (first) => first.toUpperCase());

/** Two wordings that say the same thing: case, "I'm"/"I am", articles and punctuation aside. */
export function normalizeStatement(text: string): string {
  return text
    .toLowerCase()
    .replace(/\bi'm\b/g, "i am")
    .replace(/\bdon't\b/g, "do not")
    .replace(/\b(a|an|the)\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "I do not eat meat" against "I eat meat". */
function negationOf(a: string, b: string): boolean {
  const strip = (text: string) => text.replace(/\b(do not|never|no longer)\b/g, " ").replace(/\s+/g, " ").trim();
  return a !== b && strip(a) === strip(b);
}

/** Verbs people say about many things at once ("I use Chrome" and "I use Firefox" can both be true). */
const MANY_VALUED = /^i (use|own|have|like|love|speak|play|follow|read|watch)\b/;

/** How a new fact relates to what is already known at its level. */
export function factRelationship(text: string, existing: AboutMeFact[]): { relationship: Relationship; other?: AboutMeFact } {
  const said = normalizeStatement(text);
  const topic = factTopic(clean(text));
  for (const fact of existing) {
    const known = normalizeStatement(fact.text);
    if (known === said) return { relationship: "duplicate", other: fact };
    const otherTopic = fact.topic ?? factTopic(fact.text);
    if (topic && otherTopic === topic) return { relationship: "updates", other: fact };
    if (negationOf(said, known)) return { relationship: "contradicts", other: fact };
  }
  const verb = MANY_VALUED.exec(said)?.[1];
  const sameVerb = verb ? existing.find((fact) => MANY_VALUED.exec(normalizeStatement(fact.text))?.[1] === verb) : undefined;
  return sameVerb ? { relationship: "uncertain", other: sameVerb } : { relationship: "new" };
}

/** Words that carry no fact of their own ("live", "prefer"): the rest must be in the person's message. */
const FRAME_WORDS = new Set(
  "live lived living based moved prefer like love hate enjoy usually always never name call called favourite favorite work works use have own speak study drive bank".split(" ")
);

/**
 * Is a fact the AI picked out really in the person's message? Every word
 * that carries meaning must be there. "I prefer vegetarian food" is not in
 * "find me a restaurant", whatever the AI says.
 */
export function groundedIn(fact: string, message: string): boolean {
  const said = contentWords(message);
  const needed = [...contentWords(fact)].filter((word) => !FRAME_WORDS.has(word));
  return needed.length > 0 && needed.every((word) => said.has(word));
}

/**
 * Did the person assert this themselves? Its words must be in the part of
 * the message that is their own statement, not in a quotation, an example,
 * code or someone else's words ("My friend said I live in Delhi").
 */
export function assertedIn(statement: string, message: string): boolean {
  const own = selfAssertedText(message);
  if (!own) return false;
  const said = contentWords(own);
  return [...contentWords(statement)].filter((word) => !FRAME_WORDS.has(word)).every((word) => said.has(word));
}

/** How sure the person sounded where they said it: the part of the sentence that carries the fact. */
export function certaintyWhereSaid(fact: string, sentence: string): Certainty {
  const needed = [...contentWords(fact)].filter((word) => !FRAME_WORDS.has(word));
  const clauses = sentence.split(/[,;]|\b(?:and|but|so|then)\b/i).filter((clause) => {
    const words = contentWords(clause);
    return needed.some((word) => words.has(word));
  });
  const ranked: Certainty[] = ["hypothetical", "temporary", "tentative"];
  const found = (clauses.length ? clauses : [sentence]).map(certaintyOf);
  return ranked.find((level) => found.includes(level)) ?? "clear";
}

function confidenceFor(candidate: MemoryCandidate, certainty: Certainty): number {
  if (candidate.explicit) return 1;
  const base = candidate.source.kind === "user_message" ? 0.9 : candidate.source.kind === "model_extraction" ? 0.75 : 0;
  const factor: Record<Certainty, number> = { clear: 1, tentative: 0.6, temporary: 0.3, hypothetical: 0.1 };
  return Math.round(base * factor[certainty] * 100) / 100;
}

/** The type a candidate is kept as. An explicit screen's choice wins over the classifier (fact vs preference aside). */
function resolveType(candidate: MemoryCandidate, classified: Classification): MemoryType {
  const proposed = candidate.proposed_type;
  if (candidate.explicit && proposed && proposed !== "unknown") {
    if (proposed === "fact" && classified.type === "preference") return "preference";
    return proposed;
  }
  if (candidate.explicit && classified.type === "unknown") return "fact";
  return classified.type;
}

export interface AdmitOptions {
  /** The task's or chat's writer, fixed when it started. */
  writer?: MemoryWriter;
}

/** Runs one candidate through the pipeline and says what happened. */
export async function admitMemory(candidate: MemoryCandidate, options: AdmitOptions = {}): Promise<MemoryWriteResult> {
  const started = performance.now();
  const writer = options.writer ?? localMemoryWriter;
  const result = await decideAndWrite(candidate, writer);
  void recordWriteDiagnostics({
    candidate_id: candidate.id,
    origin: candidate.source.kind,
    trust: trustOf(candidate.source.kind),
    space_id: candidate.source.space_id,
    ...(candidate.proposed_type ? { proposed_type: candidate.proposed_type } : {}),
    resolved_type: result.type,
    ...(result.certainty ? { certainty: result.certainty } : {}),
    ...(result.scope ? { scope: result.scope } : {}),
    confidence: result.confidence,
    action: result.action,
    reason: result.reason,
    ...(result.sensitive ? { sensitive: result.sensitive } : {}),
    ...(result.relationship ? { relationship: result.relationship } : {}),
    writer: writer.id,
    elapsed_ms: Math.round((performance.now() - started) * 10) / 10,
    at: new Date().toISOString()
  });
  const { certainty: _certainty, ...visible } = result;
  return { ...visible, origin: candidate.source.kind };
}

type Decided = MemoryWriteResult & { certainty?: Certainty };
/** What is known about a candidate before it is written. */
type Base = { type: MemoryType; scope: FactScope; text: string; confidence: number; certainty: Certainty };

async function decideAndWrite(candidate: MemoryCandidate, writer: MemoryWriter): Promise<Decided> {
  const proposed = candidate.proposed_type ?? "unknown";
  const raw = clean(candidate.text);
  const spaceId = candidate.source.space_id;

  // 1. Source and trust. Only the person's own words speak for them.
  const trust = trustOf(candidate.source.kind);
  if (trust === "generated") {
    return { action: "rejected", type: proposed, confidence: 0, reason: "the AI's own words are not facts about you" };
  }
  if (trust === "external") {
    if (proposed === "observation" || proposed === "procedure") {
      return { action: "ignored", type: proposed, confidence: 0, reason: "kept as task or site knowledge (observed), not as memory about you" };
    }
    return { action: "rejected", type: proposed, confidence: 0, reason: "text from a website, task, helper or file can't become a memory about you" };
  }

  // 2. Sensitivity: one check for every writer.
  const decisionText = candidate.decision ? `${candidate.decision.subject}: ${candidate.decision.value}${candidate.decision.rationale ? ` because ${candidate.decision.rationale}` : ""}` : "";
  const safety = checkSensitive(decisionText || raw);
  if (!safety.allowed) return { action: "rejected", type: proposed, confidence: 0, reason: `looks like ${safety.reason}`, sensitive: safety.reason };
  if (!decisionText && raw.length < 3) return { action: "ignored", type: proposed, confidence: 0, reason: "too short to mean anything" };

  // 3. Classification.
  const classified = classifyStatement(raw, { requireStanding: !candidate.explicit, saidIn: candidate.source.said_in });
  const type = resolveType(candidate, classified);
  const text = capital(classified.text || raw);

  // The AI's reading must be found in what the person said about themselves:
  // all of its words somewhere in the message is not enough when they sit in
  // a quotation, an example or someone else's words.
  const message = candidate.source.user_message ?? "";
  const ownWords = candidate.source.kind === "model_extraction" ? selfAssertedText(message) : "";
  if (candidate.source.kind === "model_extraction" && !groundedIn(text, ownWords)) {
    return {
      action: "rejected",
      type,
      confidence: 0,
      reason: groundedIn(text, message) ? "only in quoted or someone else's words, not said about yourself" : "not found in your message (the AI's guess, not your words)"
    };
  }
  // Picked up from chat on its own: only what the person says about themselves.
  if (candidate.source.kind === "user_message" && !candidate.explicit && !assertedIn(text, candidate.source.said_in ?? raw)) {
    return { action: "ignored", type, confidence: 0, reason: "quoted, an example or someone else's words, not said about yourself" };
  }
  const said = candidate.source.said_in ?? (candidate.source.kind === "model_extraction" ? ownWords : raw);
  const certainty = candidate.explicit ? "clear" : certaintyWhereSaid(text, said);

  // 4. Scope: this Space unless it's who you are or you said every Space.
  const scope: FactScope = candidate.requested_scope ?? factScopeIn(text, `${said} ${raw}`);
  const explicitScope = scope === "space" && (candidate.explicit_scope ?? saidForThisSpace(text, `${said} ${raw}`));

  // 5. Confidence and promotion.
  const confidence = confidenceFor(candidate, certainty);
  const base = { type, scope, text, confidence, certainty };
  if (!candidate.explicit) {
    if (certainty === "hypothetical") return { ...base, action: "ignored", reason: "sounds like a maybe, not how things are" };
    if (certainty === "temporary") return { ...base, action: "ignored", reason: "sounds temporary, so what's known stays as it is" };
    if (type === "unknown" || type === "observation" || type === "procedure") return { ...base, action: "ignored", reason: classified.why };
    if (candidate.source.kind === "model_extraction" && type !== "fact" && type !== "preference") {
      return { ...base, action: "ignored", reason: "only facts and preferences are picked out by the AI" };
    }
  }

  // 6. Relationship and write, per kind.
  if (type === "fact" || type === "preference") {
    if (!candidate.explicit && confidence < AUTO_WRITE_CONFIDENCE) return { ...base, action: "ignored", reason: "not sure enough to keep" };
    return writeFact(candidate, writer, { ...base, type }, explicitScope);
  }
  if (type === "instruction") {
    // Ordinary chat never silently adds a standing wish: it is offered.
    if (!candidate.explicit) return { ...base, action: "candidate", reason: "sounds like a standing wish; offered to keep" };
    return writeInstruction(writer, spaceId, base);
  }
  if (type === "decision") {
    const decision = candidate.decision ?? classified.decision;
    if (!decision) {
      if (candidate.explicit) return writeFact(candidate, writer, { ...base, type: "fact" }, explicitScope);
      return { ...base, action: "ignored", reason: "a choice, but not clear what it is about" };
    }
    const strength = candidate.explicit ? "strong" : (classified.decision?.strength ?? "moderate");
    const offered = { subject: decision.subject, value: decision.value, ...(decision.rationale ? { rationale: decision.rationale } : {}) };
    // A settled choice ("from now on", "we decided", "because …") is kept and can be undone; a looser one is offered.
    if (!candidate.explicit && strength !== "strong") {
      return { ...base, confidence: 0.6, action: "candidate", reason: "sounds like a decision; offered to keep", decision: offered };
    }
    return writeDecision(candidate, writer, spaceId, { ...base, confidence: candidate.explicit ? 1 : 0.85 }, offered);
  }
  return { ...base, action: "ignored", reason: classified.why };
}

/** The origin kept on the record: an accepted offer keeps where it came from, marked accepted. */
function recordOrigin(candidate: MemoryCandidate): { origin: "explicit_user" | "user_message" | "model_extraction"; accepted: boolean } {
  const offered = candidate.source.offered_from;
  const from = offered === "user_message" || offered === "model_extraction" ? offered : candidate.source.kind;
  return { origin: from as "explicit_user" | "user_message" | "model_extraction", accepted: from !== candidate.source.kind };
}

async function writeFact(
  candidate: MemoryCandidate,
  writer: MemoryWriter,
  base: Base & { type: "fact" | "preference" },
  explicitScope: boolean
): Promise<Decided> {
  const spaceId = candidate.source.space_id;
  const known = await writer.currentFacts(spaceId);
  const level = base.scope === "global" ? known.global : known.space;
  // Already said for every Space: no narrower copy.
  if (base.scope === "space" && !explicitScope && known.global.some((fact) => normalizeStatement(fact.text) === normalizeStatement(base.text))) {
    return { ...base, action: "duplicate", relationship: "duplicate", reason: "already remembered for every Space" };
  }
  const { relationship, other } = factRelationship(base.text, level);
  if (relationship === "duplicate") return { ...base, action: "duplicate", relationship, memory_id: other?.id, reason: "already remembered" };
  if (relationship === "contradicts" && !candidate.explicit) {
    return { ...base, action: "needs_confirmation", relationship, replaced_id: other?.id, reason: "says the opposite of something remembered; offered to update" };
  }
  const by: AboutMeFact["source"] = candidate.explicit && candidate.source.kind === "explicit_user" ? "you" : "learned";
  const { origin, accepted } = recordOrigin(candidate);
  const fact = await writer.writeFact(base.text, by, spaceId, base.scope, {
    explicit: explicitScope,
    chatId: candidate.source.chat_id,
    kind: base.type,
    origin,
    ...(accepted ? { accepted } : {}),
    ...(relationship === "contradicts" && other ? { replaces: other.id } : {})
  });
  if (!fact) return { ...base, action: "duplicate", relationship: "duplicate", reason: "already remembered" };
  const replaced = fact.supersedes;
  return {
    ...base,
    action: replaced ? "superseded" : "created",
    relationship: replaced ? (relationship === "contradicts" ? "contradicts" : "updates") : relationship,
    memory_id: fact.id,
    ...(replaced ? { replaced_id: replaced } : {}),
    reason: replaced ? "replaces what was true before (kept as history)" : relationship === "uncertain" ? "kept next to a similar one; both may be true" : "new"
  };
}

async function writeInstruction(writer: MemoryWriter, spaceId: string, base: Base): Promise<Decided> {
  const current = await writer.instructions(spaceId);
  const text = base.scope === "global" ? current.global : current.space;
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const said = normalizeStatement(base.text);
  if (lines.some((line) => normalizeStatement(line.replace(/^[-*]\s*/, "")) === said) || (base.scope === "space" && current.global.split("\n").some((line) => normalizeStatement(line.replace(/^[-*]\s*/, "")) === said))) {
    return { ...base, type: "instruction", action: "duplicate", relationship: "duplicate", reason: "already one of your standing wishes" };
  }
  const saved = await writer.saveInstructions([...lines, base.text].join("\n"), base.scope, spaceId);
  if (!saved.ok) return { ...base, type: "instruction", action: "rejected", reason: saved.error ?? "couldn't save" };
  return { ...base, type: "instruction", action: "created", relationship: "new", reason: "added to your standing wishes" };
}

async function writeDecision(
  candidate: MemoryCandidate,
  writer: MemoryWriter,
  spaceId: string,
  base: Base,
  decision: { subject: string; value: string; rationale?: string }
): Promise<Decided> {
  const scope = candidate.requested_scope ?? (base.scope === "global" ? "global" : "space");
  const same = (await writer.currentDecisions(spaceId)).find(
    (item) => subjectKey(item.subject) === subjectKey(decision.subject) && (item.scope === scope || scope === "space")
  );
  if (same && same.value.toLowerCase() === decision.value.toLowerCase()) {
    return { ...base, type: "decision", scope, action: "duplicate", relationship: "same_value", memory_id: same.id, decision, reason: "already decided" };
  }
  const by = candidate.explicit && candidate.source.kind === "explicit_user" ? "you" : "learned";
  const { origin, accepted } = recordOrigin(candidate);
  const saved = await writer.writeDecision({ ...decision, scope, by, chatId: candidate.source.chat_id, origin, ...(accepted ? { accepted } : {}) }, spaceId);
  if (!saved.ok) return { ...base, type: "decision", scope, action: "rejected", reason: saved.error, ...(saved.sensitive ? { sensitive: saved.sensitive } : {}) };
  return {
    ...base,
    type: "decision",
    scope,
    text: `${saved.decision.subject}: ${saved.decision.value}`,
    action: saved.replaced ? "superseded" : "created",
    relationship: saved.replaced ? "updates" : "new",
    memory_id: saved.decision.id,
    ...(saved.replaced ? { replaced_id: saved.replaced.id } : {}),
    decision: { subject: saved.decision.subject, value: saved.decision.value, ...(saved.decision.rationale ? { rationale: saved.decision.rationale } : {}) },
    reason: saved.replaced ? `replaces ${saved.replaced.value} (kept as history)` : "new decision"
  };
}
