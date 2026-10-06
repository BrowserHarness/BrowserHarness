// Memory v2 Phase 6: the write side. Everything that might be remembered
// arrives as a MemoryCandidate with a known origin, and the pipeline decides
// what happens to it. Provider-neutral: nothing here knows about storage.
import type { SensitiveReason } from "./sensitivity";

export type MemoryType = "fact" | "preference" | "instruction" | "decision" | "procedure" | "observation" | "unknown";

/**
 * Where a candidate came from. Only the person's own words (said, typed into
 * a memory screen, or picked out of their message) can become facts,
 * preferences, instructions or decisions about them.
 */
export type CandidateOrigin =
  /** The person asked to keep it: /remember, /decide, the About you screen, the instructions box. */
  | "explicit_user"
  /** Picked out of the person's own message by fixed patterns. */
  | "user_message"
  /** Picked out of the person's message by the AI (must still be found in their words). */
  | "model_extraction"
  /** The AI's own reply. Never a fact about the person. */
  | "assistant"
  /** Text on a web page, the page's structure or an API response. */
  | "browser_observation"
  /** What a task found or did. */
  | "task"
  /** What a helper found for a task. */
  | "worker"
  /** A file or link the person loaded (instructions file, SKILL.md). */
  | "import"
  /** BrowserHarness itself. */
  | "system";

/** How much a candidate's words can be trusted to speak for the person. */
export type TrustClass = "user" | "user_inferred" | "external" | "generated";

export function trustOf(origin: CandidateOrigin): TrustClass {
  switch (origin) {
    case "explicit_user":
    case "user_message":
      return "user";
    case "model_extraction":
      return "user_inferred";
    case "assistant":
    case "system":
      return "generated";
    default:
      return "external";
  }
}

export interface MemoryCandidate {
  id: string;
  text: string;
  proposed_type?: MemoryType;
  source: {
    kind: CandidateOrigin;
    space_id: string;
    chat_id?: string;
    task_id?: string;
    worker_id?: string;
    source_url?: string;
    evidence_id?: string;
    /** For model extraction: the person's message the AI read, to check the fact is really in it. */
    user_message?: string;
    /** The sentence the candidate was found in, for scope words ("for this project", "across all Spaces"). */
    said_in?: string;
  };
  requested_scope?: "space" | "global";
  /** Said for this Space on purpose ("In this Space…"). */
  explicit_scope?: boolean;
  /** The person asked for this to be kept (a memory command or screen). */
  explicit?: boolean;
  /** For a decision: what it is about and what was chosen, when already known (/decide, the Decisions screen). */
  decision?: { subject: string; value: string; rationale?: string };
}

export type Certainty = "clear" | "tentative" | "hypothetical" | "temporary";

export interface Classification {
  type: MemoryType;
  certainty: Certainty;
  /** The statement as it would be kept ("I moved to Mumbai" → "I live in Mumbai"). */
  text: string;
  /** For a decision. */
  decision?: { subject: string; value: string; rationale?: string; strength: "strong" | "moderate" };
  why: string;
}

export type Relationship = "new" | "duplicate" | "same_value" | "updates" | "contradicts" | "independent" | "uncertain";

export type WriteAction = "created" | "updated" | "superseded" | "duplicate" | "rejected" | "candidate" | "needs_confirmation" | "ignored";

export interface MemoryWriteResult {
  action: WriteAction;
  type: MemoryType;
  scope?: "space" | "global";
  /** The statement as kept or offered. */
  text?: string;
  memory_id?: string;
  replaced_id?: string;
  relationship?: Relationship;
  confidence: number;
  /** Plain words, safe to show. */
  reason: string;
  sensitive?: SensitiveReason;
  /** For a decision candidate the person can save with one tap. */
  decision?: { subject: string; value: string; rationale?: string };
}

export interface WriteDiagnostics {
  candidate_id: string;
  origin: CandidateOrigin;
  trust: TrustClass;
  space_id: string;
  proposed_type?: MemoryType;
  resolved_type: MemoryType;
  certainty?: Certainty;
  scope?: "space" | "global";
  confidence: number;
  action: WriteAction;
  reason: string;
  sensitive?: SensitiveReason;
  relationship?: Relationship;
  writer: string;
  elapsed_ms: number;
  at: string;
}
