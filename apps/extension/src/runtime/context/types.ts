// The Context Compiler's model: what could go with a request, and what did.
// Provider-neutral on purpose: no OpenAI/Anthropic/Groq message shapes here.
// A renderer (render.ts) turns a CompiledContext into what a model reads.
import type { AboutMeFact } from "../about-me";
import type { Decision } from "../decisions";
import type { TaskHistoryEntry } from "../history";
import type { TaskEpisodeMemory } from "../task-memory";
import type { UserSkill } from "../skills";

export type ContextSection =
  | "request"
  | "conversation"
  | "instructions"
  | "facts"
  | "decisions"
  | "skills"
  | "history"
  | "episodes"
  | "earlier";

/**
 * Who has the last word, highest first. A lower item never overrides a
 * higher one: the renderer says so, and selection never drops a higher item
 * to make room for a lower one.
 */
export const AUTHORITY = {
  request: 100,
  conversation: 90,
  // Fresh browser/tool state (90-85) is read by the browser agent from the live page, not compiled here.
  space_instruction: 80,
  space_memory: 75,
  global_instruction: 70,
  global_memory: 65,
  skill: 55,
  past_conversation: 45,
  past_task: 40,
  historical: 30,
  inferred: 20,
  external_observation: 10
} as const;

export type AuthorityLevel = keyof typeof AUTHORITY;

/** Where an item came from, kept for debugging and explaining; ids only where they exist. */
export interface ContextSource {
  kind: "request" | "chat_turn" | "instruction" | "fact" | "decision" | "skill" | "past_conversation" | "episode";
  id?: string;
  space_id?: string;
  chat_id?: string;
  /** For instructions: which level they came from. */
  level?: "space" | "global";
}

export interface ContextItem {
  /** Stable reference for diagnostics, like "fact:<id>" or "turn:3". */
  ref: string;
  section: ContextSection;
  authority: AuthorityLevel;
  scope: "request" | "conversation" | "space" | "global";
  temporal: "current" | "historical";
  /** Who the words come from: the person, something learned from them, or a website seen during a task. */
  trust: "user" | "learned" | "observed";
  /** 0 to 1, how much it helps this request. */
  relevance: number;
  /** Estimated cost in tokens. */
  cost: number;
  source: ContextSource;
  /** Short, human reason it was picked. */
  reason: string;
  /** The words as the model would read them (one line or block). */
  text: string;
  /** Two current facts on one topic the compiler could not settle. */
  uncertain?: boolean;
  payload?: AboutMeFact | Decision | TaskHistoryEntry | TaskEpisodeMemory | UserSkill | { role: "user" | "assistant"; text: string };
}

export type ExclusionReason =
  | "another Space"
  | "superseded"
  | "historical, request is not about the past"
  | "not relevant to this request"
  | "overridden in this Space"
  | "duplicate"
  | "budget"
  | "the current chat already covers this"
  | "browser agent recalls past tasks with the live page"
  | "not used for this kind of request";

export interface ContextExclusion {
  ref: string;
  section: ContextSection;
  reason: ExclusionReason;
  /** What it duplicates, when reason is duplicate. */
  duplicate_of?: string;
  cost?: number;
  /** For a group of records left out together (e.g. those behind the Space wall). */
  count?: number;
}

/** One model's share of the budget: its window, any provider cap, and what is left. */
export interface ModelBudget {
  provider?: string;
  model?: string;
  /** The model's context window (known, a provider default, or a safe guess). Never a rate limit. */
  model_window: number;
  window_source: "known model" | "provider default" | "unknown, conservative";
  /** A quarter of the window, never tiny, never huge. */
  context_target_before_provider_cap: number;
  /** A provider's per-request budget, kept apart from the window (for example Groq's per-minute limits). */
  provider_budget_cap?: number;
  provider_budget_reason?: string;
  /** What this model may be sent. */
  final_target: number;
}

/** Every model the request may reach, and which one sets the limit. */
export interface RouteBudget {
  intent: "chat" | "browser";
  primary: ModelBudget | null;
  fallback: ModelBudget | null;
  /** Why a configured backup was not counted (it would never receive this request). */
  fallback_not_counted?: "no backup set" | "backup did not pass the chat check" | "backup did not pass the browser-control check";
  /** Set when the backup takes over a browser task, so the main AI never receives it. */
  main_not_counted?: "main AI did not pass the browser-control check; the backup does the task";
  limited_by: "primary" | "fallback" | "fixed target";
  /** The smallest final target across the models counted. */
  safe_target: number;
}

export interface ContextBudget {
  /** Tokens the compiled context may use (request and chat included): safe for every model that may receive it. */
  target: number;
  used: number;
  /** The window of the model that limits the budget. */
  model_window: number;
  window_source: ModelBudget["window_source"];
  context_target_before_provider_cap: number;
  provider_budget_cap?: number;
  provider_budget_reason?: string;
  route?: RouteBudget;
  counting: "estimated" | "exact";
}

/**
 * turns: chat turns given to the compiler. current_records: records in force
 * in this Space, all read. stored_records: replaced records kept as history,
 * counted (read only for a question about the past). records_scanned: every
 * stored record that was scored. search_results: only what a search returned,
 * not how many records the search looked through.
 */
export interface InspectedCount {
  turns?: number;
  current_records?: number;
  stored_records?: number;
  records_scanned?: number;
  search_results?: number;
}

export interface ContextDiagnostics {
  space_id: string;
  provider?: string;
  model?: string;
  intent: "chat" | "browser";
  budget: ContextBudget;
  /** What each source handed the compiler, under names that say what was counted. Counts are never estimated. */
  inspected: Record<string, InspectedCount>;
  considered: number;
  included: Array<{ ref: string; section: ContextSection; authority: AuthorityLevel; scope: ContextItem["scope"]; temporal: ContextItem["temporal"]; relevance: number; cost: number; reason: string }>;
  excluded: ContextExclusion[];
  /** Milliseconds spent compiling. */
  elapsed_ms: number;
  compiled_at: string;
}

export interface CompiledContext {
  space_id: string;
  request: string;
  intent: "chat" | "browser";
  /** The saved Skill this request follows (asked for by name, or matched). */
  skill: UserSkill | null;
  sections: Partial<Record<ContextSection, ContextItem[]>>;
  budget: ContextBudget;
  diagnostics: ContextDiagnostics;
}
