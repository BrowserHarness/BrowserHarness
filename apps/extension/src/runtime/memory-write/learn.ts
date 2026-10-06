// The writers that feed the pipeline: /remember, the person's own messages,
// the AI's reading of a message, and accepting something BrowserHarness
// offered to keep. Each builds candidates with a known origin and leaves every
// decision to admitMemory.
import { statementsInMessage, withoutScopeWords, factScopeIn, saidForThisSpace } from "../about-me";
import { selfAssertedText } from "./assertion";
import { classifyStatement } from "./classify";
import { admitMemory } from "./pipeline";
import { refusalMessage } from "./sensitivity";
import type { CandidateOrigin, MemoryCandidate, MemoryType, MemoryWriteResult } from "./types";
import type { MemoryWriter } from "./writer";

/** Where a write happens: the Space, chat and writer fixed when the chat or task started. */
export interface WriteContext {
  spaceId: string;
  chatId?: string;
  writer?: MemoryWriter;
}

function candidate(text: string, kind: CandidateOrigin, context: WriteContext, extra: Partial<MemoryCandidate> = {}): MemoryCandidate {
  const { source, ...rest } = extra;
  return {
    id: crypto.randomUUID(),
    text,
    ...rest,
    source: { kind, space_id: context.spaceId, ...(context.chatId ? { chat_id: context.chatId } : {}), ...source }
  };
}

const KEPT = new Set(["created", "updated", "superseded"]);

export function wasKept(result: MemoryWriteResult): boolean {
  return KEPT.has(result.action);
}

/**
 * Everything worth remembering in the person's own message: statements about
 * them (kept when clear and lasting), and standing wishes and decisions
 * (offered, or for a clearly settled decision, kept with an undo).
 */
export async function learnFromMessage(message: string, context: WriteContext): Promise<MemoryWriteResult[]> {
  const results: MemoryWriteResult[] = [];
  // Only what the person says about themselves: quotations, examples, code and
  // other people's words are left out before anything is picked up.
  const own = selfAssertedText(message);
  const statements = statementsInMessage(own);
  const covered = new Set<string>();
  for (const statement of statements) {
    covered.add(statement.sentence);
    results.push(
      await admitMemory(
        candidate(statement.text, "user_message", context, {
          explicit: statement.explicit,
          source: { kind: "user_message", space_id: context.spaceId, said_in: statement.sentence }
        }),
        { writer: context.writer }
      )
    );
  }
  // Standing wishes and decisions, sentence by sentence, when no statement above came from it.
  for (const sentence of own.split(/(?<=[.!?])\s+|\n+/).map((item) => item.trim()).filter(Boolean)) {
    if (covered.has(sentence)) continue;
    const classified = classifyStatement(sentence, { requireStanding: true });
    if (classified.type !== "instruction" && classified.type !== "decision") continue;
    results.push(
      await admitMemory(
        candidate(sentence, "user_message", context, { source: { kind: "user_message", space_id: context.spaceId, said_in: sentence } }),
        { writer: context.writer }
      )
    );
  }
  return results;
}

/** Facts the AI picked out of the person's message. Each must be found in the message itself. */
export async function learnFromExtraction(facts: string[], message: string, context: WriteContext): Promise<MemoryWriteResult[]> {
  const results: MemoryWriteResult[] = [];
  for (const fact of facts.slice(0, 5)) {
    results.push(
      await admitMemory(
        candidate(fact, "model_extraction", context, { source: { kind: "model_extraction", space_id: context.spaceId, user_message: message.slice(0, 2000) } }),
        { writer: context.writer }
      )
    );
  }
  return results;
}

/** /remember: the person asked, so it is kept (after the safety, scope and duplicate checks). */
export async function rememberCommand(args: string, context: WriteContext): Promise<{ result: MemoryWriteResult; message: string }> {
  const text = withoutScopeWords(args);
  const result = await admitMemory(
    candidate(text, "explicit_user", context, {
      explicit: true,
      requested_scope: factScopeIn(args),
      explicit_scope: saidForThisSpace(args),
      source: { kind: "explicit_user", space_id: context.spaceId, said_in: args }
    }),
    { writer: context.writer }
  );
  return { result, message: rememberMessage(result) };
}

/** What /remember (and the screens) say back, in plain words. */
export function rememberMessage(result: MemoryWriteResult): string {
  const where = result.scope === "global" ? " (in every Space)" : "";
  if (result.sensitive) return refusalMessage(result.sensitive);
  if (result.action === "duplicate") return result.type === "instruction" ? "That's already one of your standing wishes." : result.type === "decision" ? "That's already decided." : "I already know that.";
  if (result.action === "rejected" || result.action === "ignored") return `I didn't save that: ${result.reason}.`;
  if (result.type === "instruction") return `Got it. I'll follow this from now on: ${result.text}${where}`;
  if (result.type === "decision") return `Noted${where}: ${result.decision?.subject} is ${result.decision?.value}.`;
  return `Got it. I'll remember: ${result.text}${where}`;
}

/** Keeps something BrowserHarness offered (a standing wish, a decision, an update): the person's tap makes it explicit. */
export async function acceptOffer(offer: MemoryWriteResult, context: WriteContext): Promise<MemoryWriteResult> {
  const type: MemoryType = offer.type;
  return admitMemory(
    candidate(offer.text ?? "", "explicit_user", context, {
      explicit: true,
      proposed_type: type,
      requested_scope: offer.scope,
      ...(offer.decision ? { decision: offer.decision } : {}),
      source: { kind: "explicit_user", space_id: context.spaceId, ...(offer.origin ? { offered_from: offer.origin } : {}) }
    }),
    { writer: context.writer }
  );
}
