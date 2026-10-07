// The Context Compiler: given a request, the Space it runs in and the model
// that will read it, decides what else goes with it. Every entry point (side
// panel chat, browser tasks, scheduled tasks, chat-app tasks) asks this, so
// memory behaves the same everywhere.
//
// Stages, each a small function below:
//   gather (from a MemorySource, inside the Space's wall)
//   → authority (this Space over every Space)
//   → time (current vs replaced)
//   → relevance (only what helps this request)
//   → duplicates and conflicts
//   → budget (by authority, within the model's share)
//   → the compiled, provider-neutral result (render.ts turns it into text)
import { factTopic, type AboutMeFact } from "../about-me";
import { subjectKey, type Decision } from "../decisions";
import type { TaskHistoryEntry } from "../history";
import { classifyTaskIntent } from "../intent";
import { looksBack } from "../recall";
import type { UserSkill } from "../skills";
import type { TaskEpisodeMemory } from "../task-memory";
import { ASKS_ABOUT_VERIFICATION, dagRecallText, verificationSummary } from "../task-provenance";
import { budgetForRoute, estimateTokens, SECTION_SHARE, type RouteInput } from "./budget";
import { localMemorySource, type MemorySource } from "./memory-source";
import { decisionUsefulness, factUsefulness, isFollowUp, overlap } from "./relevance";
import {
  AUTHORITY,
  type CompiledContext,
  type ContextExclusion,
  type ContextItem,
  type ContextSection,
  type ExclusionReason,
  type InspectedCount
} from "./types";

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export interface CompileInput {
  /** What the person asked, in their words (used to judge what helps). */
  request: string;
  /** The Space fixed when the task started. Never re-read during compiling. */
  spaceId: string;
  /** This chat so far, oldest first, not including the new request. */
  conversation?: ChatTurn[];
  chatId?: string;
  /** The main AI, for the budget. */
  connection?: RouteInput["primary"];
  /**
   * The backup AI. It counts toward the budget only when it may receive this
   * request (passed the chat check for a chat, the browser-control check for
   * a browser task), so the context fits every model that may read it.
   */
  fallback?: RouteInput["fallback"];
  /** A Skill the person ran by name; it always comes along. */
  skill?: UserSkill | null;
  /** Offer a saved Skill that looks like this request (the "Use my Skills automatically" setting). */
  autoSkills?: boolean;
  /** Look in past conversations (off for a Skill run by name). */
  recall?: boolean;
  /** Chat or browser; worked out from the request when not given. */
  intent?: "chat" | "browser";
  /** Memory to read; defaults to this device's. */
  source?: MemorySource;
  /** Override the budget (tokens), e.g. for an overview. */
  budgetTarget?: number;
  /** Which sections to fill; all by default. */
  only?: ContextSection[];
}

const MAX_TURN_CHARS = 1500;
const MAX_HISTORY = 5;
const MAX_EPISODES = 3;
/** How alike an episode must be to come along without the request looking back. */
const EPISODE_MATCH = 0.5;

const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function item(partial: Omit<ContextItem, "cost">): ContextItem {
  return { ...partial, cost: estimateTokens(partial.text) + 1 };
}

function day(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "earlier" : date.toISOString().slice(0, 10);
}

function clip(text: string, max: number): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

const topicOf = (fact: AboutMeFact) => fact.topic ?? factTopic(fact.text);

interface Gathered {
  items: ContextItem[];
  excluded: ContextExclusion[];
  inspected: Record<string, InspectedCount>;
  skill: UserSkill | null;
}

/** Stage 1: everything that could go along, read only from inside the Space's wall. */
async function gather(input: CompileInput, intent: "chat" | "browser", source: MemorySource): Promise<Gathered> {
  const { request, spaceId } = input;
  const wants = (section: ContextSection) => !input.only || input.only.includes(section);
  const items: ContextItem[] = [];
  const excluded: ContextExclusion[] = [];
  const inspected: Record<string, InspectedCount> = {};

  items.push(
    item({
      ref: "request",
      section: "request",
      authority: "request",
      scope: "request",
      temporal: "current",
      trust: "user",
      relevance: 1,
      source: { kind: "request" },
      reason: "what you asked",
      text: request
    })
  );

  const turns = (input.conversation ?? []).filter((turn) => turn.text.trim());
  inspected.conversation = { turns: turns.length };
  if (wants("conversation")) {
    turns.forEach((turn, index) => {
      const text = turn.text.trim();
      items.push(
        item({
          ref: `turn:${index}`,
          section: "conversation",
          authority: "conversation",
          scope: "conversation",
          temporal: "current",
          trust: turn.role === "user" ? "user" : "learned",
          // Newer turns matter more.
          relevance: 1 - (turns.length - 1 - index) * 0.01,
          source: { kind: "chat_turn", chat_id: input.chatId, space_id: spaceId },
          reason: "this chat",
          text: `${turn.role === "user" ? "Me" : "You"}: ${text.length > MAX_TURN_CHARS ? `${text.slice(0, MAX_TURN_CHARS)}…` : text}`,
          payload: { role: turn.role, text }
        })
      );
    });
  }

  const current = await source.currentState(spaceId);
  inspected.facts = { current_records: current.facts.space.length + current.facts.global.length };
  inspected.decisions = { current_records: current.decisions.length };
  for (const [what, count] of Object.entries(current.walled)) {
    if (count) excluded.push({ ref: `${what}:other-spaces`, section: what === "decisions" ? "decisions" : "facts", reason: "another Space", count });
  }

  if (wants("instructions")) {
    for (const level of ["space", "global"] as const) {
      current.instructions[level]
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach((line, index) =>
          items.push(
            item({
              ref: `instruction:${level}:${index}`,
              section: "instructions",
              authority: level === "space" ? "space_instruction" : "global_instruction",
              scope: level,
              temporal: "current",
              trust: "user",
              relevance: 1,
              source: { kind: "instruction", level, space_id: level === "space" ? spaceId : undefined },
              reason: level === "space" ? "this Space's instruction" : "instruction for every Space",
              text: line
            })
          )
        );
    }
  }

  if (wants("facts")) {
    for (const level of ["space", "global"] as const) {
      for (const fact of current.facts[level]) {
        items.push(
          item({
            ref: `fact:${fact.id}`,
            section: "facts",
            authority: level === "space" ? "space_memory" : "global_memory",
            scope: level,
            temporal: "current",
            trust: fact.source === "you" ? "user" : "learned",
            relevance: 0,
            source: { kind: "fact", id: fact.id, space_id: fact.provenance?.space_id, chat_id: fact.provenance?.chat_id, level },
            reason: "",
            text: fact.text,
            payload: fact
          })
        );
      }
    }
  }

  if (wants("decisions")) {
    for (const decision of current.decisions) {
      const level = decision.visibility === "all" ? "global" : "space";
      items.push(
        item({
          ref: `decision:${decision.id}`,
          section: "decisions",
          authority: level === "space" ? "space_memory" : "global_memory",
          scope: level,
          temporal: "current",
          trust: "user",
          relevance: 0,
          source: { kind: "decision", id: decision.id, space_id: decision.space_id, chat_id: decision.provenance.chat_id, level },
          reason: "",
          text: `${decision.subject}: ${decision.value}${decision.rationale ? ` (because ${decision.rationale})` : ""}`,
          payload: decision
        })
      );
    }
  }

  // Replaced facts and decisions: only for a question about the past.
  if (wants("earlier")) {
    const earlier = await source.earlierState(request, spaceId);
    inspected.earlier = { stored_records: current.earlierCount };
    const found = earlier.facts.length + earlier.decisions.length;
    if (current.earlierCount > found) {
      excluded.push({
        ref: "earlier:not-asked",
        section: "earlier",
        reason: found ? "not relevant to this request" : "historical, request is not about the past",
        count: current.earlierCount - found
      });
    }
    for (const fact of earlier.facts) {
      items.push(
        item({
          ref: `fact:${fact.id}`,
          section: "earlier",
          authority: "historical",
          scope: fact.level,
          temporal: "historical",
          trust: fact.source === "you" ? "user" : "learned",
          relevance: 0.6,
          source: { kind: "fact", id: fact.id, space_id: fact.provenance?.space_id, chat_id: fact.provenance?.chat_id },
          reason: earlier.method === "words+meaning" ? "the past question matches it by meaning" : "the past question is about it",
          text: `${fact.text} (until ${(fact.valid_until ?? "").slice(0, 10) || "later"})`,
          payload: fact
        })
      );
    }
    for (const decision of earlier.decisions) {
      items.push(
        item({
          ref: `decision:${decision.id}`,
          section: "earlier",
          authority: "historical",
          scope: decision.visibility === "all" ? "global" : "space",
          temporal: "historical",
          trust: "user",
          relevance: 0.6,
          source: { kind: "decision", id: decision.id, space_id: decision.space_id, chat_id: decision.provenance.chat_id },
          reason: "the past question is about it",
          text: `${decision.subject}: ${decision.value}${decision.rationale ? ` (because ${decision.rationale})` : ""}, ${decision.status === "reversed" ? "taken back" : "replaced"} ${(decision.valid_until ?? "").slice(0, 10)}`,
          payload: decision
        })
      );
    }
  }

  // Skills: one asked for by name, or the best match in this Space.
  let skill: UserSkill | null = input.skill ?? null;
  if (wants("skills")) {
    if (skill) {
      // Its steps are already the task itself.
      excluded.push({ ref: `skill:${skill.id}`, section: "skills", reason: "duplicate", duplicate_of: "request" });
    } else if (input.autoSkills !== false) {
      const found = await source.relevantSkills(request, spaceId, 1);
      inspected.skills = { records_scanned: found.inspected };
      if (found.walled) excluded.push({ ref: "skills:other-spaces", section: "skills", reason: "another Space", count: found.walled });
      const best = found.skills[0];
      if (best) {
        skill = best.skill;
        items.push(skillItem(best.skill, best.score, "a saved Skill matches the request"));
      } else if (found.inspected) {
        excluded.push({ ref: "skills:no-match", section: "skills", reason: "not relevant to this request", count: found.inspected });
      }
    }
  }

  // Past conversations and past tasks: retrieval material, never whole chats.
  const followUp = turns.length > 0 && isFollowUp(request);
  if (wants("history") && input.recall !== false) {
    if (followUp) {
      excluded.push({ ref: "history:follow-up", section: "history", reason: "the current chat already covers this" });
    } else {
      const found = await source.relevantHistory(request, spaceId, MAX_HISTORY);
      inspected.history = { records_scanned: found.inspected };
      found.entries.forEach((entry: TaskHistoryEntry) =>
        items.push(
          item({
            ref: `history:${entry.id}`,
            section: "history",
            authority: "past_conversation",
            scope: "space",
            temporal: "historical",
            trust: "learned",
            relevance: looksBack(request) ? 0.8 : 0.6,
            source: { kind: "past_conversation", id: entry.id, space_id: spaceId },
            reason: looksBack(request) ? "the request refers back to it" : "a very close earlier request",
            text: `${day(entry.timestamp)}: I asked “${clip(entry.task, 160)}” → ${clip(entry.result, 400)}${entry.url ? ` (${entry.url})` : ""}`,
            payload: entry
          })
        )
      );
    }
  }

  if (wants("episodes") && input.recall !== false) {
    if (intent === "browser") {
      excluded.push({ ref: "episodes:browser", section: "episodes", reason: "browser agent recalls past tasks with the live page" });
    } else if (followUp) {
      excluded.push({ ref: "episodes:follow-up", section: "episodes", reason: "the current chat already covers this" });
    } else {
      const found = await source.relevantEpisodes(request, spaceId, MAX_EPISODES);
      // A search result count, not how many past tasks the search looked through.
      inspected.episodes = { search_results: found.episodes.length };
      if (found.walled) excluded.push({ ref: "episodes:other-spaces", section: "episodes", reason: "another Space", count: found.walled });
      for (const episode of found.episodes) {
        // A question about what a helper or verifier looked into can match the DAG's own tasks and findings.
        const checkedScore = overlap(request, dagRecallText(episode.dag_runs));
        const score = Math.max(overlap(request, `${episode.title} ${episode.task}`), checkedScore);
        const fits = looksBack(request) ? score > 0 : score >= EPISODE_MATCH;
        if (!fits) {
          excluded.push({ ref: `episode:${episode.id}`, section: "episodes", reason: "not relevant to this request" });
          continue;
        }
        items.push(episodeItem(episode, score, spaceId, checkedScore > 0 || ASKS_ABOUT_VERIFICATION.test(request)));
      }
    }
  }

  return { items, excluded, inspected, skill };
}

function skillItem(skill: UserSkill, score: number, reason: string): ContextItem {
  return item({
    ref: `skill:${skill.id}`,
    section: "skills",
    authority: "skill",
    scope: skill.visibility === "all" ? "global" : "space",
    temporal: "current",
    trust: "user",
    relevance: Math.max(0.5, score),
    source: { kind: "skill", id: skill.id, space_id: skill.space_id },
    reason,
    text: `${skill.instructions}\n${skill.lessons.join("\n")}`,
    payload: skill
  });
}

/** Most lines of verifier detail one recalled episode may add. */
const MAX_VERIFICATION_LINES = 3;

function episodeItem(episode: TaskEpisodeMemory, score: number, spaceId: string, withChecks = false): ContextItem {
  const helpers = (episode.delegations ?? [])
    .flatMap((delegation) => delegation.sources.map((source) => source.url))
    .slice(0, 3);
  // Verifier detail only when it helps this request; a claim always goes with its verdict.
  const checks = withChecks ? verificationSummary(episode.dag_runs, MAX_VERIFICATION_LINES) : [];
  const verdicts = (episode.dag_runs ?? []).flatMap((run) => run.nodes.map((node) => node.verdict));
  // Historical evidence a verifier supported ranks a little above unchecked work; it stays a past task.
  const verified = withChecks && verdicts.includes("supported") && !verdicts.includes("contradicted") ? 0.05 : 0;
  return item({
    ref: `episode:${episode.id}`,
    section: "episodes",
    authority: "past_task",
    scope: "space",
    temporal: "historical",
    // What a task saw on websites back then: an observation, not the person's word.
    trust: "observed",
    relevance: Math.min(1, Math.max(0.5, score) + verified),
    source: { kind: "episode", id: episode.id, space_id: episode.space_id ?? spaceId },
    reason: checks.length ? "a past task in this Space like this one, with what its verifier concluded" : "a past task in this Space like this one",
    text: `${day(episode.recorded_at)}: “${clip(episode.task, 160)}” (${episode.status}${episode.sites.length ? `, on ${episode.sites.slice(0, 3).join(", ")}` : ""}${helpers.length ? `; helpers' sources then: ${helpers.join(", ")}` : ""})${checks.map((line) => `\n  ${line}`).join("")}`,
    payload: episode
  });
}

/** Stage 2: this Space's own facts, decisions and instructions win over the ones for every Space. */
function resolveAuthority(items: ContextItem[], excluded: ContextExclusion[]): ContextItem[] {
  const ownTopics = new Map<string, string>();
  const ownSubjects = new Map<string, string>();
  const ownLines = new Map<string, string>();
  for (const entry of items) {
    if (entry.section === "facts" && entry.scope === "space") {
      const topic = topicOf(entry.payload as AboutMeFact);
      if (topic) ownTopics.set(topic, entry.ref);
    }
    if (entry.section === "decisions" && entry.scope === "space") ownSubjects.set(subjectKey((entry.payload as Decision).subject), entry.ref);
    if (entry.section === "instructions" && entry.scope === "space") ownLines.set(normalize(entry.text), entry.ref);
  }
  return items.filter((entry) => {
    let winner: string | undefined;
    if (entry.section === "facts" && entry.scope === "global") {
      const topic = topicOf(entry.payload as AboutMeFact);
      winner = topic ? ownTopics.get(topic) : undefined;
    } else if (entry.section === "decisions" && entry.scope === "global") {
      winner = ownSubjects.get(subjectKey((entry.payload as Decision).subject));
    } else if (entry.section === "instructions" && entry.scope === "global") {
      const same = ownLines.get(normalize(entry.text));
      if (same) {
        excluded.push({ ref: entry.ref, section: entry.section, reason: "duplicate", duplicate_of: same, cost: entry.cost });
        return false;
      }
    }
    if (!winner) return true;
    excluded.push({ ref: entry.ref, section: entry.section, reason: "overridden in this Space", duplicate_of: winner, cost: entry.cost });
    return false;
  });
}

/** Stage 3: what is true now goes as current; anything replaced only as history, never twice. */
function resolveTime(items: ContextItem[], excluded: ContextExclusion[]): ContextItem[] {
  const currentTexts = new Map(items.filter((entry) => entry.temporal === "current" && (entry.section === "facts" || entry.section === "decisions")).map((entry) => [normalize(entry.text), entry.ref]));
  return items.filter((entry) => {
    if (entry.section !== "earlier") return true;
    const text = entry.section === "earlier" && entry.source.kind === "fact" ? (entry.payload as AboutMeFact).text : entry.text;
    const same = currentTexts.get(normalize(text));
    if (!same) return true;
    excluded.push({ ref: entry.ref, section: entry.section, reason: "duplicate", duplicate_of: same, cost: entry.cost });
    return false;
  });
}

/** Stage 4: keep facts and decisions that help this request. With no request (an overview) everything current is kept. */
function selectRelevant(items: ContextItem[], excluded: ContextExclusion[], request: string): ContextItem[] {
  const overview = !request.trim();
  return items.filter((entry) => {
    if (entry.section !== "facts" && entry.section !== "decisions") return true;
    let judged: { score: number; reason: string };
    if (overview) judged = { score: 0.5, reason: "overview of what is true now" };
    else if (entry.section === "facts") {
      const fact = entry.payload as AboutMeFact;
      judged = factUsefulness(request, fact.text, topicOf(fact));
    } else {
      const decision = entry.payload as Decision;
      judged = decisionUsefulness(request, decision.subject, decision.value);
    }
    if (judged.score <= 0) {
      excluded.push({ ref: entry.ref, section: entry.section, reason: "not relevant to this request", cost: entry.cost });
      return false;
    }
    entry.relevance = judged.score;
    entry.reason = `${entry.scope === "space" ? "this Space" : "every Space"}: ${judged.reason}`;
    return true;
  });
}

/**
 * Stage 5: the same knowledge once, from its strongest source (what was said
 * in this chat beats memory), and two current facts on one topic at the same
 * level marked as unsure rather than one picked at random.
 */
function dedupeAndConflicts(items: ContextItem[], excluded: ContextExclusion[]): ContextItem[] {
  const chat = items.filter((entry) => entry.section === "conversation");
  const chatText = normalize(chat.map((entry) => (entry.payload as { text: string }).text).join(" \n "));
  const userTurns = new Map(chat.filter((entry) => entry.trust === "user").map((entry) => [normalize((entry.payload as { text: string }).text), entry.ref]));
  const seen = new Map<string, string>();
  const kept = items.filter((entry) => {
    if (entry.section === "request" || entry.section === "conversation") return true;
    const core =
      entry.section === "facts" || entry.section === "earlier"
        ? normalize(entry.source.kind === "fact" ? (entry.payload as AboutMeFact).text : entry.text)
        : entry.section === "history"
          ? normalize((entry.payload as TaskHistoryEntry).task)
          : normalize(entry.text);
    let duplicateOf: string | undefined;
    if (entry.section === "history") duplicateOf = userTurns.get(core);
    else if ((entry.section === "facts" || entry.section === "decisions") && core.length > 6 && chatText.includes(core)) {
      duplicateOf = chat.find((turn) => normalize((turn.payload as { text: string }).text).includes(core))?.ref;
    }
    duplicateOf ??= seen.get(`${entry.section}:${core}`);
    if (duplicateOf) {
      excluded.push({ ref: entry.ref, section: entry.section, reason: "duplicate", duplicate_of: duplicateOf, cost: entry.cost });
      return false;
    }
    seen.set(`${entry.section}:${core}`, entry.ref);
    return true;
  });
  const byTopic = new Map<string, ContextItem[]>();
  for (const entry of kept) {
    if (entry.section !== "facts") continue;
    const topic = topicOf(entry.payload as AboutMeFact);
    if (!topic) continue;
    const key = `${entry.scope}:${topic}`;
    byTopic.set(key, [...(byTopic.get(key) ?? []), entry]);
  }
  for (const group of byTopic.values()) if (group.length > 1) for (const entry of group) entry.uncertain = true;
  return kept;
}

/** Order for filling the budget: higher authority first, then more relevant, then newer turns. */
function priority(a: ContextItem, b: ContextItem): number {
  return AUTHORITY[b.authority] - AUTHORITY[a.authority] || b.relevance - a.relevance;
}

/** Stage 6: fill the model's share, highest authority first; each section has a ceiling so none crowds out the rest. */
function fitBudget(items: ContextItem[], excluded: ContextExclusion[], target: number): { kept: ContextItem[]; used: number } {
  const perSection = new Map<ContextSection, number>();
  const kept: ContextItem[] = [];
  let used = 0;
  for (const entry of [...items].sort(priority)) {
    const sectionUsed = perSection.get(entry.section) ?? 0;
    const fits = entry.section === "request" || (used + entry.cost <= target && sectionUsed + entry.cost <= SECTION_SHARE[entry.section] * target);
    if (!fits) {
      excluded.push({ ref: entry.ref, section: entry.section, reason: "budget", cost: entry.cost });
      continue;
    }
    kept.push(entry);
    used += entry.cost;
    perSection.set(entry.section, sectionUsed + entry.cost);
  }
  return { kept, used };
}

const SECTION_ORDER: ContextSection[] = ["request", "conversation", "instructions", "facts", "decisions", "earlier", "history", "episodes", "skills"];

/** Compiles the context for one request. */
export async function compileContext(input: CompileInput): Promise<CompiledContext> {
  const started = performance.now();
  const source = input.source ?? localMemorySource;
  // The intent may depend on the Skill found, so gather first with the request's own intent.
  const guessed = input.intent ?? (input.skill ? "browser" : classifyTaskIntent(input.request));
  const gathered = await gather(input, guessed, source);
  const intent = input.intent ?? (gathered.skill ? "browser" : guessed);
  let items = gathered.items;
  const excluded = gathered.excluded;
  if (intent === "browser" && guessed === "chat") {
    // A matched Skill turned this into a browser task: past tasks are the agent's to recall.
    items = items.filter((entry) => {
      if (entry.section !== "episodes") return true;
      excluded.push({ ref: entry.ref, section: entry.section, reason: "browser agent recalls past tasks with the live page" });
      return false;
    });
  }
  const considered = items.length;
  items = resolveAuthority(items, excluded);
  items = resolveTime(items, excluded);
  items = selectRelevant(items, excluded, input.request);
  items = dedupeAndConflicts(items, excluded);

  const budget = budgetForRoute({ primary: input.connection, fallback: input.fallback, intent });
  if (input.budgetTarget) {
    budget.target = input.budgetTarget;
    if (budget.route) budget.route.limited_by = "fixed target";
  }
  const fitted = fitBudget(items, excluded, budget.target);
  budget.used = fitted.used;

  const sections: CompiledContext["sections"] = {};
  for (const section of SECTION_ORDER) {
    const inSection = fitted.kept.filter((entry) => entry.section === section);
    if (!inSection.length) continue;
    // Chat turns and instructions keep their written order; the rest by relevance.
    sections[section] =
      section === "conversation" || section === "instructions"
        ? inSection.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }))
        : inSection.sort(priority);
  }
  const skill = input.skill ?? (sections.skills?.length ? gathered.skill : null);

  return {
    space_id: input.spaceId,
    request: input.request,
    intent,
    skill,
    sections,
    budget,
    diagnostics: {
      space_id: input.spaceId,
      provider: input.connection?.provider,
      model: input.connection?.model,
      intent,
      budget,
      inspected: gathered.inspected,
      considered,
      included: fitted.kept.map((entry) => ({
        ref: entry.ref,
        section: entry.section,
        authority: entry.authority,
        scope: entry.scope,
        temporal: entry.temporal,
        relevance: Math.round(entry.relevance * 100) / 100,
        cost: entry.cost,
        reason: entry.reason
      })),
      excluded: excluded.slice(0, 200),
      elapsed_ms: Math.round((performance.now() - started) * 10) / 10,
      compiled_at: new Date().toISOString()
    }
  };
}

export type { ExclusionReason };
