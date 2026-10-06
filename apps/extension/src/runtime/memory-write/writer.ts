// Where admitted memories are kept. The pipeline (pipeline.ts) decides what
// is remembered, as what, where, and whether it replaces something; a writer
// only reads what it needs to compare and stores what it is told.
//
// Today there is one writer, this device's storage. A later one (self-hosted,
// cloud, Honcho- or Mem0-style) implements the same interface. It may store,
// index, enrich and sync, but Space scope, page-versus-person trust, current
// truth, replacement and safety stay decided by BrowserHarness, before any
// writer is called.
import { addFacts, loadAboutMe, loadGlobalAboutMe, type AboutMeFact, type AddFactOptions, type FactScope } from "../about-me";
import { currentDecisions, recordDecision, undoDecision, type Decision, type DecisionInput } from "../decisions";
import { loadGlobalInstructions, loadInstructions, saveGlobalInstructions, saveInstructions } from "../instructions";
import { indexTaskEpisodeMemory } from "../semantic-memory";
import type { BrowserTaskSessionEvidence } from "../session-evidence";
import { saveTaskEpisodeMemory, type TaskEpisodeMemory } from "../task-memory";

export interface MemoryWriter {
  readonly id: string;
  /** Current facts and preferences at both levels, to compare a candidate with. */
  currentFacts(spaceId: string): Promise<{ space: AboutMeFact[]; global: AboutMeFact[] }>;
  writeFact(text: string, by: AboutMeFact["source"], spaceId: string, scope: FactScope, options: AddFactOptions): Promise<AboutMeFact | null>;
  instructions(spaceId: string): Promise<{ space: string; global: string }>;
  /** Replaces the standing instructions at one level. */
  saveInstructions(text: string, scope: FactScope, spaceId: string): Promise<{ ok: boolean; error?: string }>;
  currentDecisions(spaceId: string): Promise<Decision[]>;
  writeDecision(input: DecisionInput, spaceId: string): ReturnType<typeof recordDecision>;
  undoDecision(id: string, spaceId: string): Promise<boolean>;
  /** What a task saw and did: kept as task knowledge (observed), never as facts about the person. */
  recordTaskEpisode(evidence: BrowserTaskSessionEvidence, spaceId: string): Promise<TaskEpisodeMemory>;
}

/** This device's memory (chrome.storage.local), through the existing stores. */
export class BrowserHarnessLocalMemoryWriter implements MemoryWriter {
  readonly id = "browserharness-local";

  async currentFacts(spaceId: string) {
    const [space, global] = await Promise.all([loadAboutMe(spaceId), loadGlobalAboutMe()]);
    return { space, global };
  }

  async writeFact(text: string, by: AboutMeFact["source"], spaceId: string, scope: FactScope, options: AddFactOptions) {
    return (await addFacts([text], by, spaceId, scope, options))[0] ?? null;
  }

  async instructions(spaceId: string) {
    const [space, global] = await Promise.all([loadInstructions(spaceId), loadGlobalInstructions()]);
    return { space, global };
  }

  saveInstructions(text: string, scope: FactScope, spaceId: string) {
    return scope === "global" ? saveGlobalInstructions(text) : saveInstructions(text, spaceId);
  }

  currentDecisions(spaceId: string) {
    return currentDecisions(spaceId);
  }

  writeDecision(input: DecisionInput, spaceId: string) {
    return recordDecision(input, spaceId);
  }

  undoDecision(id: string, spaceId: string) {
    return undoDecision(id, spaceId);
  }

  async recordTaskEpisode(evidence: BrowserTaskSessionEvidence, spaceId: string) {
    const episode = await saveTaskEpisodeMemory(evidence, spaceId);
    await indexTaskEpisodeMemory(episode).catch(() => null);
    return episode;
  }
}

export const localMemoryWriter: MemoryWriter = new BrowserHarnessLocalMemoryWriter();
