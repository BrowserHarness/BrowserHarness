// Where the Context Compiler reads memory from. The compiler never reaches
// into storage keys itself; it asks a MemorySource. Today there is one, the
// memory kept on this device. A later source (a self-hosted or cloud memory
// service) would implement the same reads.
//
// A source only stores and finds. BrowserHarness keeps deciding Space scope,
// what is true now, what replaced what, trust and what reaches the model:
// every read takes the task's Space and returns only what that Space may see
// (the wall in memory-scope.ts runs before any search), and the compiler
// applies authority, time, relevance and budget on top.
import {
  asksAboutThePast,
  earlierFactsFor,
  loadAboutMe,
  loadEarlierFacts,
  loadGlobalAboutMe,
  type AboutMeFact
} from "../about-me";
import { countDecisionsOutsideSpace, currentDecisions, earlierDecisionsFor, type Decision } from "../decisions";
import { loadTaskHistory } from "../history";
import { withVerification, type RecalledHistoryEntry } from "../history-verification";
import { loadGlobalInstructions, loadInstructions } from "../instructions";
import { embedTexts } from "../model-client";
import { recallFor } from "../recall";
import { cosineSimilarity, searchTaskMemoryHybrid } from "../semantic-memory";
import { matchSkill } from "../skill-learning";
import { loadAllSkills, loadSkills, type UserSkill } from "../skills";
import { countEpisodesOutsideSpace, type TaskEpisodeMemory } from "../task-memory";
import { loadEmbeddingConnection } from "../../settings/provider-store";

/** What is true now in a Space, at each level. Precedence between levels is the compiler's job. */
export interface CurrentMemory {
  instructions: { space: string; global: string };
  facts: { space: AboutMeFact[]; global: AboutMeFact[] };
  /** In force in this Space: its own, then those for every Space that it doesn't override. */
  decisions: Decision[];
  /** Stored records this Space may not see, counted by tag only (never read, never scored). */
  walled: Record<string, number>;
  /** Replaced facts and decisions kept as history in this Space and every Space. */
  earlierCount: number;
}

/** A replaced fact, with the level it was kept at. */
export type EarlierFact = AboutMeFact & { level: "space" | "global" };

export interface MemorySource {
  readonly id: string;
  currentState(spaceId: string): Promise<CurrentMemory>;
  /** What used to be true and matches a question about the past; nothing for an ordinary request. */
  earlierState(request: string, spaceId: string): Promise<{ facts: EarlierFact[]; decisions: Decision[]; method: "words" | "words+meaning" }>;
  /** Each entry carries its task's verification when it has one; a source without episodes returns entries unchanged. */
  relevantHistory(request: string, spaceId: string, limit: number): Promise<{ entries: RecalledHistoryEntry[]; inspected: number }>;
  relevantEpisodes(request: string, spaceId: string, limit: number): Promise<{ episodes: TaskEpisodeMemory[]; walled: number }>;
  relevantSkills(request: string, spaceId: string, limit: number): Promise<{ skills: Array<{ skill: UserSkill; score: number }>; inspected: number; walled: number }>;
}

/** Most earlier facts compared by meaning in one request. */
const MAX_MEANING_CANDIDATES = 40;
const MEANING_THRESHOLD = 0.5;

/** The memory kept on this device (chrome.storage.local). */
export class BrowserHarnessLocalMemorySource implements MemorySource {
  readonly id = "browserharness-local";

  async currentState(spaceId: string): Promise<CurrentMemory> {
    const [space, global, spaceFacts, globalFacts, decisions, earlierSpace, earlierGlobal, walledDecisions] = await Promise.all([
      loadInstructions(spaceId).catch(() => ""),
      loadGlobalInstructions().catch(() => ""),
      loadAboutMe(spaceId).catch(() => []),
      loadGlobalAboutMe().catch(() => []),
      currentDecisions(spaceId).catch(() => []),
      loadEarlierFacts(spaceId).catch(() => []),
      loadEarlierFacts(undefined, "global").catch(() => []),
      countDecisionsOutsideSpace(spaceId).catch(() => 0)
    ]);
    return {
      instructions: { space, global },
      facts: { space: spaceFacts, global: globalFacts },
      decisions,
      walled: { decisions: walledDecisions },
      earlierCount: earlierSpace.length + earlierGlobal.length
    };
  }

  async earlierState(request: string, spaceId: string): Promise<{ facts: EarlierFact[]; decisions: Decision[]; method: "words" | "words+meaning" }> {
    if (!asksAboutThePast(request)) return { facts: [], decisions: [], method: "words" };
    const [words, decisions, shared] = await Promise.all([
      earlierFactsFor(request, spaceId).catch(() => []),
      earlierDecisionsFor(request, spaceId).catch(() => []),
      loadEarlierFacts(undefined, "global").catch(() => [])
    ]);
    const globalIds = new Set(shared.map((fact) => fact.id));
    const tag = (facts: AboutMeFact[]): EarlierFact[] => facts.map((fact) => ({ ...fact, level: globalIds.has(fact.id) ? "global" : "space" }));
    if (words.length) return { facts: tag(words), decisions, method: "words" };
    // Nothing by words: compare by meaning, if an embedding model is set up. One bounded call.
    const meaning = await this.earlierFactsByMeaning(request, spaceId).catch(() => []);
    return { facts: tag(meaning), decisions, method: meaning.length ? "words+meaning" : "words" };
  }

  private async earlierFactsByMeaning(request: string, spaceId: string): Promise<AboutMeFact[]> {
    const connection = await loadEmbeddingConnection();
    if (!connection) return [];
    const candidates = [...(await loadEarlierFacts(spaceId)), ...(await loadEarlierFacts(undefined, "global"))].slice(0, MAX_MEANING_CANDIDATES);
    if (!candidates.length) return [];
    const result = await embedTexts(connection, [request.slice(0, 500), ...candidates.map((fact) => fact.text)]);
    const [question, ...vectors] = result.vectors;
    return candidates
      .map((fact, index) => ({ fact, similarity: cosineSimilarity(question, vectors[index]) ?? 0 }))
      .filter((item) => item.similarity >= MEANING_THRESHOLD)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 3)
      .map((item) => item.fact);
  }

  async relevantHistory(request: string, spaceId: string, limit: number): Promise<{ entries: RecalledHistoryEntry[]; inspected: number }> {
    const entries = await loadTaskHistory(spaceId).catch(() => []);
    const found = recallFor(entries, request).slice(0, limit);
    // An answer goes with what its task's verifier concluded (read from that task's episode, in this Space).
    return { entries: await withVerification(found, spaceId).catch(() => found), inspected: entries.length };
  }

  async relevantEpisodes(request: string, spaceId: string, limit: number): Promise<{ episodes: TaskEpisodeMemory[]; walled: number }> {
    const [hits, walled] = await Promise.all([
      searchTaskMemoryHybrid(request, limit, spaceId).catch(() => []),
      countEpisodesOutsideSpace(spaceId).catch(() => 0)
    ]);
    return { episodes: hits.map((hit) => hit.episode), walled };
  }

  async relevantSkills(request: string, spaceId: string, limit: number): Promise<{ skills: Array<{ skill: UserSkill; score: number }>; inspected: number; walled: number }> {
    const [visible, all] = await Promise.all([loadSkills(spaceId).catch(() => []), loadAllSkills().catch(() => [])]);
    const best = matchSkill(request, visible);
    return { skills: best ? [best].slice(0, limit) : [], inspected: visible.length, walled: all.length - visible.length };
  }
}

export const localMemorySource: MemorySource = new BrowserHarnessLocalMemorySource();
