// Space backups (Memory v2 Phase 9): one file with everything a Space owns,
// brought back later as a new, independent Space.
//
// A backup takes what the Space OWNS, never everything it can SEE. A Space
// sees things set for every Space (facts, wishes, decisions, Skills) and
// Skills from before Skills belonged to a Space; none of those is in a
// Space's backup. What is in it:
//   - its own stores (chats, About you facts with their history, wishes,
//     past conversations);
//   - its own records in the shared stores: private decisions with their
//     history, private Skills, task episodes with helper, Task DAG and
//     verifier evidence;
//   - its scheduled tasks.
// Derived or short-lived data is never in it: meaning indexes and embedding
// caches (rebuilt on their own from the restored records), Context Compiler
// and memory-write diagnostics, working memory, chat-app queues, memory
// offers waiting for a tap, and anything shared on purpose (connected AIs,
// safety choices, settings, Site Skills, recordings, site grants).
//
// Restoring always makes a new Space beside the others. Records in shared
// stores get new ids (so a copy never shares a record with its original),
// and every link between them is rewritten to the new ids: a decision's
// history, a copied Skill's source, a task's helper and verifier sessions,
// and the link from a saved answer to the task that verified it. Everything
// is checked and cleaned with today's rules before anything is written, a
// file can never add something for every Space, and a failed write leaves
// nothing behind.
import { isStorableFact, MAX_EARLIER, MAX_FACTS, type AboutMeFact, type Provenance } from "./about-me";
import { MAX_CHAT_MESSAGES, MAX_CHATS, MAX_TITLE, sortChats, type ChatMessage, type SavedChat } from "./chats";
import { MAX_DECISIONS, type Decision, type DecisionStatus } from "./decisions";
import { MAX_HISTORY, safeHistoryEntry, type TaskHistoryEntry } from "./history";
import { MAX_INSTRUCTIONS } from "./instructions";
import { checkSensitive, isSafeToRemember } from "./memory-write/sensitivity";
import { isChatApp, MAX_SCHEDULES, type Schedule, type ScheduledTask } from "./schedules";
import { MAX_SKILLS, skillSlug, uniqueSlug, type SkillProvenance, type UserSkill } from "./skills";
import { BUILT_IN_COMMANDS } from "./slash-commands";
import {
  cleanSpaceName,
  createSpace,
  deleteSpace,
  keyForSpace,
  loadSpaces,
  MAX_SPACES,
  ownedBySpaceId,
  SCHEDULES_KEY,
  SPACE_COLORS,
  SPACE_SCOPED_KEYS,
  SPACE_TAGGED_KEYS,
  type Space
} from "./spaces";
import {
  MAX_DAG_RUNS,
  MAX_DELEGATIONS,
  MAX_EPISODES,
  MAX_SITES,
  MAX_SKILL_REFS,
  MAX_TARGETS,
  type TaskEpisodeDagNode,
  type TaskEpisodeDagRun,
  type TaskEpisodeDelegation,
  type TaskEpisodeMemory
} from "./task-memory";
import { findingSummary, redactSecrets, safeSources, safeSourceUrl, safeTask, safeTitle, safeTools, workerStatus, type DagNodeStatus, type Verdict } from "./task-provenance";
import { MAX_TASK_DAG_NODES } from "./task-dag";

export const SPACE_BACKUP_KIND = "browserharness-space-backup";
/** A backup file larger than this is not read at all. */
export const MAX_BACKUP_CHARS = 60 * 1024 * 1024;

type ScopedName = keyof typeof SPACE_SCOPED_KEYS;

/** The first backups: only the Space's own four stores. Still brought back as they are. */
export interface SpaceBackupV1 {
  kind: typeof SPACE_BACKUP_KIND;
  version: 1;
  saved_at: string;
  space: { name: string; color: string };
  data: Partial<Record<ScopedName, unknown>>;
}

export interface SpaceBackupCounts {
  chats: number;
  facts: number;
  earlier_facts: number;
  instructions: number;
  history: number;
  decisions: number;
  earlier_decisions: number;
  skills: number;
  episodes: number;
  dag_runs: number;
  schedules: number;
}

/** Everything a Space owns (Phase 9). */
export interface SpaceBackupV2 {
  kind: typeof SPACE_BACKUP_KIND;
  version: 2;
  saved_at: string;
  source_space: { id: string; name: string; color: string };
  data: {
    /** The Space's own stores, as kept. */
    scoped: {
      chats?: unknown;
      aboutMe?: unknown;
      instructions?: unknown;
      history?: unknown;
    };
    /** The Space's own records from the shared stores. */
    tagged: {
      skills?: unknown;
      decisions?: unknown;
      episodes?: unknown;
    };
    /** Scheduled tasks made in this Space. They come back paused. */
    schedules?: unknown;
  };
  manifest: { counts: SpaceBackupCounts; left_out: string[] };
}

export type SpaceBackup = SpaceBackupV1 | SpaceBackupV2;

/** Kept for every backup, in plain words: what is never in it and why. */
export const LEFT_OUT_OF_BACKUPS = [
  "Things set for every Space (facts, wishes, decisions and Skills): they belong to all your Spaces, not this one",
  "Skills from before Skills belonged to a Space, and Site Skills: they are shared",
  "Connected AIs, safety choices, settings, chat-app connections and site permissions: they are shared",
  "Watch Me recordings and what was learned about websites: they are shared",
  "Search indexes and caches: they are rebuilt on their own",
  "Diagnostics, working notes, waiting chat-app tasks and memory offers: they are short-lived"
];

const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown, max = 10_000): string => (typeof value === "string" ? value.slice(0, max) : "");
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isDate = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), 1_000_000) : 0);

async function storeValue(key: string): Promise<unknown> {
  return (await chrome.storage.local.get(key))[key];
}

async function ownedRecords(kind: keyof typeof SPACE_TAGGED_KEYS | "schedules", spaceId: string): Promise<unknown[]> {
  const key = kind === "schedules" ? SCHEDULES_KEY : SPACE_TAGGED_KEYS[kind];
  return array(await storeValue(key)).filter((record) => ownedBySpaceId(kind, record, spaceId));
}

function isCurrent(record: { status?: unknown }): boolean {
  return !record.status || record.status === "current";
}

function countsOf(data: SpaceBackupV2["data"]): SpaceBackupCounts {
  const facts = array(data.scoped.aboutMe) as Array<{ status?: unknown }>;
  const decisions = array(data.tagged.decisions) as Array<{ status?: unknown }>;
  const episodes = array(data.tagged.episodes) as Array<{ dag_runs?: unknown }>;
  return {
    chats: array(data.scoped.chats).length,
    facts: facts.filter(isCurrent).length,
    earlier_facts: facts.filter((fact) => !isCurrent(fact)).length,
    instructions: typeof data.scoped.instructions === "string" && data.scoped.instructions.trim() ? 1 : 0,
    history: array(data.scoped.history).length,
    decisions: decisions.filter(isCurrent).length,
    earlier_decisions: decisions.filter((decision) => !isCurrent(decision)).length,
    skills: array(data.tagged.skills).length,
    episodes: episodes.length,
    dag_runs: episodes.reduce((sum, episode) => sum + array(episode.dag_runs).length, 0),
    schedules: array(data.schedules).length
  };
}

/** What a Space owns, counted the way a backup or a delete sees it. */
export async function spaceContents(spaceId: string): Promise<SpaceBackupCounts> {
  return countsOf(await ownedData(spaceId));
}

async function ownedData(spaceId: string): Promise<SpaceBackupV2["data"]> {
  const scoped: SpaceBackupV2["data"]["scoped"] = {};
  for (const [name, base] of Object.entries(SPACE_SCOPED_KEYS) as Array<[ScopedName, string]>) {
    const value = await storeValue(keyForSpace(base, spaceId));
    if (value !== undefined) scoped[name] = value;
  }
  const episodes = (await ownedRecords("episodes", spaceId)).filter(
    (item) => isObject(item) && item.schema_version === 1 && item.kind === "task_episode"
  );
  return {
    scoped,
    tagged: {
      skills: await ownedRecords("skills", spaceId),
      decisions: await ownedRecords("decisions", spaceId),
      episodes
    },
    schedules: await ownedRecords("schedules", spaceId)
  };
}

/** Everything one Space owns, as one file. Nothing set for every Space and nothing from another Space. */
export async function backupSpace(id: string): Promise<SpaceBackupV2> {
  const { spaces } = await loadSpaces();
  const space = spaces.find((item) => item.id === id);
  if (!space) throw new Error("That Space no longer exists.");
  const data = await ownedData(id);
  return {
    kind: SPACE_BACKUP_KIND,
    version: 2,
    saved_at: new Date().toISOString(),
    source_space: { id: space.id, name: space.name, color: space.color },
    data,
    manifest: { counts: countsOf(data), left_out: LEFT_OUT_OF_BACKUPS }
  };
}

/** Reads a backup file of either version; null when it isn't one. Nothing in it is trusted yet. */
export function parseSpaceBackup(raw: string): SpaceBackup | null {
  if (typeof raw !== "string" || raw.length > MAX_BACKUP_CHARS) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw.replace(/^﻿/, ""));
  } catch {
    return null;
  }
  if (!isObject(value) || value.kind !== SPACE_BACKUP_KIND || !isObject(value.data)) return null;
  if (value.version === 1 || value.version === undefined) {
    if (!isObject(value.space) || typeof value.space.name !== "string") return null;
    return { ...(value as unknown as SpaceBackupV1), version: 1 };
  }
  if (value.version !== 2) return null;
  const data = value.data;
  if (!isObject(value.source_space) || typeof value.source_space.name !== "string") return null;
  if (!isObject(data.scoped) || (data.tagged !== undefined && !isObject(data.tagged))) return null;
  return value as unknown as SpaceBackupV2;
}

// ---------------------------------------------------------------------------
// Restore: check and clean every record, give shared-store records new ids,
// rewrite every link, then write once.

export interface RestoreCounts {
  chats: number;
  facts: number;
  earlier_facts: number;
  instructions: boolean;
  history: number;
  decisions: number;
  earlier_decisions: number;
  skills: number;
  episodes: number;
  schedules: number;
}

/** Why records were not brought back, with how many. */
export interface RestoreSkipped {
  /** Looked like a password, key, code or other secret. */
  secret: number;
  /** Claimed to be for every Space; a Space backup can only bring back the Space's own things. */
  every_space: number;
  /** Not readable as what it claimed to be. */
  unreadable: number;
  /** More than a Space can keep. */
  over_limit: number;
  /** Scheduled tasks with no room left (at most MAX_SCHEDULES in all). */
  schedules_no_room: number;
}

export type RestoreResult =
  | {
      ok: true;
      space: Space;
      restored: RestoreCounts;
      skipped: RestoreSkipped;
      renamed_commands: Array<{ from: string; to: string }>;
      warnings: string[];
      /** How long checking and preparing took, and writing (with the read-back check). */
      timings: { prepare_ms: number; write_ms: number };
    }
  | { ok: false; error: string };

interface Plan {
  scoped: Record<string, unknown>;
  skills: UserSkill[];
  decisions: Decision[];
  episodes: TaskEpisodeMemory[];
  schedules: ScheduledTask[];
  restored: RestoreCounts;
  skipped: RestoreSkipped;
}

/** Rewrites references to the old Space so they point at the new one; other Spaces' ids stay as history. */
function spaceMapper(sourceId: string | undefined, newId: string): (id: unknown) => string | undefined {
  return (id) => {
    if (typeof id !== "string" || !id) return undefined;
    return sourceId && id === sourceId ? newId : id.slice(0, 80);
  };
}

function provenanceOf(raw: unknown, mapSpace: (id: unknown) => string | undefined, newId: string): Provenance | undefined {
  if (!isObject(raw)) return undefined;
  const by = raw.by === "you" || raw.by === "learned" ? raw.by : undefined;
  if (!by) return undefined;
  const origins = ["explicit_user", "user_message", "model_extraction"];
  return {
    by,
    space_id: mapSpace(raw.space_id) ?? newId,
    at: isDate(raw.at) ? raw.at : new Date(0).toISOString(),
    ...(typeof raw.chat_id === "string" && raw.chat_id ? { chat_id: raw.chat_id.slice(0, 80) } : {}),
    ...(origins.includes(raw.origin as string) ? { origin: raw.origin as Provenance["origin"] } : {}),
    ...(raw.accepted === true ? { accepted: true } : {})
  };
}

function restoreChats(raw: unknown, skipped: RestoreSkipped): SavedChat[] {
  const chats: SavedChat[] = [];
  const ids = new Set<string>();
  for (const item of array(raw)) {
    if (!isObject(item) || typeof item.id !== "string" || !item.id || ids.has(item.id) || !Array.isArray(item.messages)) {
      skipped.unreadable += 1;
      continue;
    }
    // A chat is an archive of what was said: kept as it was, never turned into memory.
    const messages: ChatMessage[] = item.messages
      .filter((message): message is Record<string, unknown> => isObject(message) && (message.role === "user" || message.role === "assistant") && typeof message.text === "string")
      .slice(-MAX_CHAT_MESSAGES)
      .map((message) => ({
        id: typeof message.id === "string" && message.id ? message.id.slice(0, 80) : crypto.randomUUID(),
        role: message.role as ChatMessage["role"],
        text: (message.text as string).slice(0, 100_000),
        ...(isDate(message.at) ? { at: message.at } : {}),
        ...(message.problem !== undefined ? { problem: message.problem } : {})
      }));
    const created = isDate(item.created_at) ? item.created_at : new Date().toISOString();
    ids.add(item.id);
    chats.push({
      id: item.id.slice(0, 80),
      title: text(item.title, MAX_TITLE) || "Chat",
      ...(item.named === true ? { named: true } : {}),
      ...(item.pinned === true ? { pinned: true } : {}),
      created_at: created,
      updated_at: isDate(item.updated_at) ? item.updated_at : created,
      messages
    });
  }
  const sorted = sortChats(chats);
  const kept = sorted.length > MAX_CHATS ? [...sorted.filter((chat) => chat.pinned), ...sorted.filter((chat) => !chat.pinned)].slice(0, MAX_CHATS) : sorted;
  skipped.over_limit += sorted.length - kept.length;
  return kept;
}

const FACT_STATUSES = new Set(["current", "superseded", "historical"]);

function restoreFacts(raw: unknown, mapSpace: (id: unknown) => string | undefined, newId: string, skipped: RestoreSkipped): AboutMeFact[] {
  const facts: AboutMeFact[] = [];
  const ids = new Set<string>();
  for (const item of array(raw)) {
    if (!isObject(item) || typeof item.id !== "string" || !item.id || ids.has(item.id) || typeof item.text !== "string") {
      skipped.unreadable += 1;
      continue;
    }
    // The same check as remembering it today: a password or code never comes back as a fact.
    if (!isStorableFact(item.text)) {
      skipped.secret += 1;
      continue;
    }
    ids.add(item.id);
    const provenance = provenanceOf(item.provenance, mapSpace, newId);
    facts.push({
      id: item.id.slice(0, 80),
      text: item.text.replace(/\s+/g, " ").trim().slice(0, 200),
      source: item.source === "learned" ? "learned" : "you",
      created_at: isDate(item.created_at) ? item.created_at : new Date(0).toISOString(),
      ...(typeof item.topic === "string" && item.topic ? { topic: item.topic.slice(0, 60) } : {}),
      ...(FACT_STATUSES.has(item.status as string) ? { status: item.status as AboutMeFact["status"] } : {}),
      ...(isDate(item.valid_from) ? { valid_from: item.valid_from } : {}),
      ...(isDate(item.valid_until) ? { valid_until: item.valid_until } : {}),
      ...(typeof item.supersedes === "string" ? { supersedes: item.supersedes } : {}),
      ...(typeof item.superseded_by === "string" ? { superseded_by: item.superseded_by } : {}),
      ...(item.explicit_scope === true ? { explicit_scope: true } : {}),
      ...(item.kind === "fact" || item.kind === "preference" ? { kind: item.kind } : {}),
      ...(provenance ? { provenance } : {})
    });
  }
  // A link to a fact that didn't come back points at nothing.
  for (const fact of facts) {
    if (fact.supersedes && !ids.has(fact.supersedes)) delete fact.supersedes;
    if (fact.superseded_by && !ids.has(fact.superseded_by)) delete fact.superseded_by;
  }
  const current = facts.filter(isCurrent);
  const earlier = facts.filter((fact) => !isCurrent(fact));
  skipped.over_limit += Math.max(0, current.length - MAX_FACTS) + Math.max(0, earlier.length - MAX_EARLIER);
  return [...current.slice(0, MAX_FACTS), ...earlier.slice(0, MAX_EARLIER)];
}

function restoreInstructions(raw: unknown, skipped: RestoreSkipped): string | undefined {
  if (typeof raw !== "string") return undefined;
  const lines = raw.slice(0, MAX_INSTRUCTIONS * 2).split("\n");
  const kept = lines.filter((line) => checkSensitive(line).allowed);
  skipped.secret += lines.length - kept.length;
  return kept.join("\n").trim().slice(0, MAX_INSTRUCTIONS);
}

function restoreHistory(raw: unknown, sessions: Map<string, string>, skipped: RestoreSkipped): TaskHistoryEntry[] {
  const entries: TaskHistoryEntry[] = [];
  const ids = new Set<string>();
  for (const item of array(raw)) {
    if (!isObject(item) || typeof item.task !== "string" || typeof item.result !== "string") {
      skipped.unreadable += 1;
      continue;
    }
    const id = typeof item.id === "string" && item.id && !ids.has(item.id) ? item.id.slice(0, 80) : crypto.randomUUID();
    ids.add(id);
    // Today's cleaning, whatever the file says: links without credentials, no secret-looking line.
    const clean = safeHistoryEntry({ task: item.task, result: item.result, ...(typeof item.url === "string" ? { url: item.url } : {}) });
    // The link to the task that produced this answer follows the task to its new session; without that task it links nothing.
    const session = typeof item.session_id === "string" ? sessions.get(item.session_id) : undefined;
    entries.push({ id, timestamp: isDate(item.timestamp) ? item.timestamp : new Date(0).toISOString(), ...clean, ...(session ? { session_id: session } : {}) });
  }
  skipped.over_limit += Math.max(0, entries.length - MAX_HISTORY);
  return entries.slice(0, MAX_HISTORY);
}

const DECISION_STATUSES = new Set<DecisionStatus>(["current", "superseded", "reversed", "historical"]);
const DECISION_TEXT = 160;

function restoreDecisions(raw: unknown, mapSpace: (id: unknown) => string | undefined, newId: string, skipped: RestoreSkipped): Decision[] {
  const ids = new Map<string, string>();
  const decisions: Array<{ old: Record<string, unknown>; decision: Decision }> = [];
  for (const item of array(raw)) {
    if (!isObject(item) || typeof item.id !== "string" || !item.id || ids.has(item.id) || typeof item.subject !== "string" || typeof item.value !== "string") {
      skipped.unreadable += 1;
      continue;
    }
    // A Space backup can only bring back the Space's own decisions, never one for every Space.
    if (item.visibility === "all" || item.scope === "global") {
      skipped.every_space += 1;
      continue;
    }
    const subject = item.subject.replace(/\s+/g, " ").trim().slice(0, DECISION_TEXT);
    const value = item.value.replace(/\s+/g, " ").trim().slice(0, DECISION_TEXT);
    const rationale = typeof item.rationale === "string" ? item.rationale.replace(/\s+/g, " ").trim().slice(0, DECISION_TEXT) : "";
    if (subject.length < 2 || !value) {
      skipped.unreadable += 1;
      continue;
    }
    if (!checkSensitive(`${subject}: ${value}${rationale ? ` because ${rationale}` : ""}`).allowed) {
      skipped.secret += 1;
      continue;
    }
    const id = crypto.randomUUID();
    ids.set(item.id, id);
    const created = isDate(item.created_at) ? item.created_at : new Date(0).toISOString();
    decisions.push({
      old: item,
      decision: {
        id,
        type: "decision",
        subject,
        value,
        ...(rationale ? { rationale } : {}),
        scope: "space",
        status: DECISION_STATUSES.has(item.status as DecisionStatus) ? (item.status as DecisionStatus) : "historical",
        created_at: created,
        ...(isDate(item.valid_from) ? { valid_from: item.valid_from } : {}),
        ...(isDate(item.valid_until) ? { valid_until: item.valid_until } : {}),
        space_id: newId,
        visibility: "space",
        provenance: provenanceOf(item.provenance, mapSpace, newId) ?? { by: "you", space_id: newId, at: created }
      }
    });
  }
  // The history between decisions follows them to their new ids; a link to one that didn't come back is dropped.
  for (const { old, decision } of decisions) {
    const supersedes = typeof old.supersedes === "string" ? ids.get(old.supersedes) : undefined;
    const supersededBy = typeof old.superseded_by === "string" ? ids.get(old.superseded_by) : undefined;
    if (supersedes) decision.supersedes = supersedes;
    if (supersededBy) decision.superseded_by = supersededBy;
  }
  skipped.over_limit += Math.max(0, decisions.length - MAX_DECISIONS);
  return decisions.slice(0, MAX_DECISIONS).map((item) => item.decision);
}

const SKILL_SOURCES = new Set<UserSkill["source"]>(["chat", "recording", "import", "auto"]);
const SKILL_ORIGINS = new Set<SkillProvenance["origin"]>(["learned", "saved", "recording", "imported", "copied", "legacy"]);

/** Skill steps as kept: a line that looks like it holds a secret is replaced. */
function safeSteps(instructions: string): string {
  return instructions
    .slice(0, 8000)
    .split("\n")
    .map((line) => (checkSensitive(line).allowed ? line : "(left out: it looked like a secret)"))
    .join("\n");
}

function restoreSkills(
  raw: unknown,
  mapSpace: (id: unknown) => string | undefined,
  newId: string,
  skipped: RestoreSkipped
): { skills: UserSkill[]; ids: Map<string, string> } {
  const ids = new Map<string, string>();
  const parsed: Array<{ old: Record<string, unknown>; skill: UserSkill }> = [];
  for (const item of array(raw)) {
    if (!isObject(item) || typeof item.id !== "string" || !item.id || ids.has(item.id) || typeof item.name !== "string" || typeof item.instructions !== "string") {
      skipped.unreadable += 1;
      continue;
    }
    // Only the Space's own Skills: one marked for every Space (or with no Space at all) never comes back through a Space backup.
    // A Skill tagged with a Space before visibility was kept (Phase 2–6) is that Space's own, as it reads today.
    if (item.visibility === "all" || (item.visibility !== "space" && !(typeof item.space_id === "string" && item.space_id))) {
      skipped.every_space += 1;
      continue;
    }
    const name = item.name.replace(/\s+/g, " ").trim().slice(0, 80);
    const description = typeof item.description === "string" ? item.description.slice(0, 500) : "";
    if (!name || !isSafeToRemember(name) || !isSafeToRemember(description)) {
      skipped.secret += 1;
      continue;
    }
    const id = crypto.randomUUID();
    ids.set(item.id, id);
    const created = isDate(item.created_at) ? item.created_at : new Date().toISOString();
    const startUrl = typeof item.start_url === "string" ? safeSourceUrl(item.start_url) : "";
    parsed.push({
      old: item,
      skill: {
        id,
        name,
        slug: typeof item.slug === "string" && item.slug ? item.slug : skillSlug(name),
        description,
        instructions: safeSteps(item.instructions),
        ...(startUrl ? { start_url: startUrl } : {}),
        source: SKILL_SOURCES.has(item.source as UserSkill["source"]) ? (item.source as UserSkill["source"]) : "import",
        created_at: created,
        updated_at: isDate(item.updated_at) ? item.updated_at : created,
        runs: count(item.runs),
        successes: count(item.successes),
        failures: count(item.failures),
        ...(isDate(item.last_run_at) ? { last_run_at: item.last_run_at } : {}),
        lessons: array(item.lessons)
          .filter((lesson): lesson is string => typeof lesson === "string" && isSafeToRemember(lesson))
          .map((lesson) => lesson.slice(0, 240))
          .slice(0, 8),
        space_id: newId,
        visibility: "space"
      }
    });
  }
  // Where each Skill came from stays as it was; links to Skills in this backup follow them to their new ids.
  for (const { old, skill } of parsed) {
    const source = isObject(old.provenance) ? old.provenance : undefined;
    if (!source || !SKILL_ORIGINS.has(source.origin as SkillProvenance["origin"])) continue;
    const sourceSkill = typeof source.source_skill_id === "string" ? (ids.get(source.source_skill_id) ?? source.source_skill_id.slice(0, 80)) : undefined;
    const sourceSpace = mapSpace(source.source_space_id);
    const madeIn = mapSpace(source.space_id);
    skill.provenance = {
      origin: source.origin as SkillProvenance["origin"],
      ...(madeIn ? { space_id: madeIn } : {}),
      ...(isDate(source.at) ? { at: source.at } : {}),
      ...(sourceSkill ? { source_skill_id: sourceSkill } : {}),
      ...(sourceSpace ? { source_space_id: sourceSpace } : {}),
      ...(isDate(source.copied_at) ? { copied_at: source.copied_at } : {})
    };
  }
  skipped.over_limit += Math.max(0, parsed.length - MAX_SKILLS);
  return { skills: parsed.slice(0, MAX_SKILLS).map((item) => item.skill), ids };
}

const NODE_STATUSES = new Set<DagNodeStatus>(["completed", "failed", "blocked", "cancelled"]);
const VERDICTS = new Set<Verdict>(["supported", "contradicted", "insufficient"]);
const EPISODE_STATUSES = new Set(["completed", "stopped", "approval-cancelled"]);

/**
 * New task sessions for restored episodes. Every session id of the backup gets
 * one new id; a helper's session (`<parent>:worker:…`) keeps its shape under
 * the parent's new id, so the lineage reads the same.
 */
class SessionMap {
  readonly parents = new Map<string, string>();
  constructor(oldIds: string[]) {
    for (const id of oldIds) if (!this.parents.has(id)) this.parents.set(id, crypto.randomUUID());
  }
  get(id: unknown): string | undefined {
    if (typeof id !== "string" || !id) return undefined;
    const direct = this.parents.get(id);
    if (direct) return direct;
    for (const [old, next] of this.parents) if (id.startsWith(`${old}:`)) return `${next}${id.slice(old.length)}`.slice(0, 300);
    // A session this backup doesn't explain still gets an id of its own, so two restores never share one.
    const fresh = crypto.randomUUID();
    this.parents.set(id, fresh);
    return fresh;
  }
}

function pageContext(raw: unknown): TaskEpisodeMemory["start"] | undefined {
  if (!isObject(raw)) return undefined;
  const url = typeof raw.url === "string" ? raw.url : "";
  let origin = "";
  try {
    origin = new URL(url).origin;
  } catch {
    origin = "";
  }
  return { tab_id: typeof raw.tab_id === "number" ? raw.tab_id : -1, url: safeSourceUrl(url) || (origin === "null" ? "" : origin), title: safeTitle(raw.title) };
}

function strings(raw: unknown, max: number, each = 200, keep: (value: string) => boolean = () => true): string[] {
  return [...new Set(array(raw).filter((item): item is string => typeof item === "string" && item.length > 0).map((item) => item.slice(0, each)).filter(keep))].slice(0, max);
}

function restoreDelegations(raw: unknown, parent: string, sessions: SessionMap): TaskEpisodeDelegation[] {
  return array(raw)
    .filter(isObject)
    .flatMap((item): TaskEpisodeDelegation[] => {
      const status = workerStatus(item.status);
      const session = sessions.get(item.session_id);
      if (!status || !session || typeof item.action_id !== "string") return [];
      return [{
        action_id: item.action_id.slice(0, 80),
        worker_index: count(item.worker_index),
        task: safeTask(text(item.task)),
        session_id: session,
        status,
        sources: safeSources(item.sources),
        tools_used: safeTools(item.tools_used),
        parent_session_id: sessions.get(item.parent_session_id) ?? parent,
        trust: "observed",
        ...(item.mode === "read" || item.mode === "act" ? { mode: item.mode } : {})
      }];
    })
    .slice(0, MAX_DELEGATIONS);
}

/**
 * A Task DAG as evidence from the backup: node ids, edges and verdicts stay
 * exactly; sessions follow the parent to its new id. Nothing is re-run or
 * re-judged, and nothing is trusted more than it was: a verdict exists only
 * on a verifier that completed, trust labels are the fixed ones, and helpers
 * stay read-only.
 */
function restoreDagRuns(raw: unknown, parent: string, sessions: SessionMap): TaskEpisodeDagRun[] {
  return array(raw)
    .filter(isObject)
    .flatMap((run): TaskEpisodeDagRun[] => {
      if (typeof run.action_id !== "string") return [];
      const nodes: TaskEpisodeDagNode[] = [];
      const ids = new Set<string>();
      for (const item of array(run.nodes).slice(0, MAX_TASK_DAG_NODES)) {
        if (!isObject(item) || typeof item.node_id !== "string" || !item.node_id || ids.has(item.node_id)) continue;
        const type = item.type === "verify" ? "verify" : item.type === "research" ? "research" : null;
        const status = NODE_STATUSES.has(item.status as DagNodeStatus) ? (item.status as DagNodeStatus) : null;
        if (!type || !status) continue;
        ids.add(item.node_id);
        const verdict = type === "verify" && status === "completed" ? (VERDICTS.has(item.verdict as Verdict) ? (item.verdict as Verdict) : "insufficient") : undefined;
        const finding = typeof item.finding === "string" ? findingSummary(item.finding) : undefined;
        // A node that never ran has no session; none is made up for it.
        const child = typeof item.child_session_id === "string" && item.child_session_id ? sessions.get(item.child_session_id) : undefined;
        const worker = workerStatus(item.worker_status);
        nodes.push({
          node_id: item.node_id.slice(0, 80),
          type,
          task: safeTask(text(item.task)),
          status,
          ...(worker ? { worker_status: worker } : {}),
          mode: "read",
          ...(child ? { child_session_id: child } : {}),
          depends_on: strings(item.depends_on, MAX_TASK_DAG_NODES, 80),
          ...(status === "blocked" && typeof item.blocked_by === "string" ? { blocked_by: item.blocked_by.slice(0, 80) } : {}),
          sources: safeSources(item.sources),
          tools_used: safeTools(item.tools_used),
          ...(verdict ? { verdict } : {}),
          ...(finding ? { finding } : {}),
          trust: { sources: "observed", ...(finding ? { finding: "derived" as const } : {}), ...(verdict ? { verdict: "derived_verification" as const } : {}) }
        });
      }
      if (!nodes.length) return [];
      for (const node of nodes) {
        node.depends_on = node.depends_on.filter((dep) => ids.has(dep) && dep !== node.node_id);
        if (node.blocked_by && !ids.has(node.blocked_by)) delete node.blocked_by;
      }
      // Each claim carries the verifiers that checked it, worked out again from the kept edges.
      for (const node of nodes) {
        if (node.type !== "research") continue;
        const checks = nodes
          .filter((other) => other.type === "verify" && other.depends_on.includes(node.node_id))
          .map((other) => ({ node_id: other.node_id, status: other.status, ...(other.verdict ? { verdict: other.verdict } : {}) }));
        if (checks.length) node.checked_by = checks;
      }
      const tally = (status: DagNodeStatus) => nodes.filter((node) => node.status === status).length;
      return [{
        action_id: run.action_id.slice(0, 80),
        parent_session_id: sessions.get(run.parent_session_id) ?? parent,
        nodes,
        completed_count: tally("completed"),
        failed_count: tally("failed"),
        blocked_count: tally("blocked"),
        cancelled_count: tally("cancelled"),
        cancelled: run.cancelled === true
      }];
    })
    .slice(0, MAX_DAG_RUNS);
}

function restoreEpisodes(
  raw: unknown,
  newId: string,
  skipped: RestoreSkipped
): { episodes: TaskEpisodeMemory[]; sessions: Map<string, string> } {
  const valid = array(raw).filter(
    (item): item is Record<string, unknown> =>
      isObject(item) && item.schema_version === 1 && item.kind === "task_episode" && typeof item.session_id === "string" && Boolean(item.session_id) && typeof item.id === "string"
  );
  skipped.unreadable += array(raw).length - valid.length;
  const map = new SessionMap(valid.map((item) => item.session_id as string));
  const episodes: TaskEpisodeMemory[] = [];
  for (const item of valid) {
    if (item.visibility === "all") {
      skipped.every_space += 1;
      continue;
    }
    const oldSession = item.session_id as string;
    const session = map.get(oldSession)!;
    const oldId = item.id as string;
    const recorded = isDate(item.recorded_at) ? item.recorded_at : new Date(0).toISOString();
    const suffix = oldId.startsWith(`episode:${oldSession}:`) ? oldId.slice(`episode:${oldSession}:`.length) : recorded;
    const start = pageContext(item.start) ?? { tab_id: -1, url: "", title: "" };
    const end = pageContext(item.end);
    const delegations = restoreDelegations(item.delegations, session, map);
    const dagRuns = restoreDagRuns(item.dag_runs, session, map);
    const provenance = isObject(item.provenance) && item.provenance.origin === "task" ? { origin: "task" as const, space_id: newId, at: isDate(item.provenance.at) ? item.provenance.at : recorded } : undefined;
    const status = EPISODE_STATUSES.has(item.status as string) ? (item.status as TaskEpisodeMemory["status"]) : ("stopped" as TaskEpisodeMemory["status"]);
    episodes.push({
      schema_version: 1,
      id: `episode:${session}:${suffix}`.slice(0, 400),
      kind: "task_episode",
      recorded_at: recorded,
      session_id: session,
      title: redactSecrets(text(item.title, 160).replace(/\s+/g, " ").trim(), 160),
      task: redactSecrets(text(item.task, 1000).replace(/\s+/g, " ").trim()),
      status,
      start,
      ...(end ? { end } : {}),
      action_count: count(item.action_count),
      manual_handoff_count: count(item.manual_handoff_count),
      tools: strings(item.tools, 50, 60),
      targets: strings(item.targets, MAX_TARGETS, 160, isSafeToRemember),
      sites: strings(item.sites, MAX_SITES, 300, (site) => Boolean(safeSourceUrl(site))),
      skill_refs: array(item.skill_refs)
        .filter((ref): ref is Record<string, unknown> => isObject(ref) && typeof ref.id === "string" && typeof ref.action === "string")
        .slice(0, MAX_SKILL_REFS)
        .map((ref) => ({ id: (ref.id as string).slice(0, 120), action: (ref.action as string).slice(0, 120), ...(typeof ref.revision_id === "string" ? { revision_id: ref.revision_id.slice(0, 120) } : {}) })),
      ...(delegations.length ? { delegations } : {}),
      ...(dagRuns.length ? { dag_runs: dagRuns } : {}),
      ...(typeof item.boundary_action_id === "string" ? { boundary_action_id: item.boundary_action_id.slice(0, 80) } : {}),
      sensitive_payloads_removed: true,
      space_id: newId,
      trust: "observed",
      ...(provenance ? { provenance } : {})
    });
  }
  skipped.over_limit += Math.max(0, episodes.length - MAX_EPISODES);
  const kept = episodes.slice(0, MAX_EPISODES);
  // Only sessions of episodes that came back are linked from saved answers.
  const sessions = new Map<string, string>();
  for (const item of valid) {
    const next = map.parents.get(item.session_id as string);
    if (next && kept.some((episode) => episode.session_id === next)) sessions.set(item.session_id as string, next);
  }
  return { episodes: kept, sessions };
}

function validSchedule(raw: unknown): Schedule | null {
  if (!isObject(raw)) return null;
  if (raw.kind === "once" && isDate(raw.at)) return { kind: "once", at: raw.at };
  if (raw.kind === "interval" && typeof raw.minutes === "number" && raw.minutes > 0) return { kind: "interval", minutes: Math.round(raw.minutes) };
  if (raw.kind === "daily" && typeof raw.time === "string" && /^\d{1,2}:\d{2}$/.test(raw.time) && Array.isArray(raw.days)) {
    const days = [...new Set(raw.days.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6))];
    return days.length ? { kind: "daily", time: raw.time, days } : null;
  }
  return null;
}

const SCHEDULE_STATUSES = new Set(["worked", "failed", "needs you"]);

/**
 * Scheduled tasks come back paused, with new ids, in the new Space: a copy
 * beside the original must never send the same email or message twice on
 * its own. Turning one back on works out its next run as usual.
 */
function restoreSchedules(raw: unknown, newId: string, renamed: Map<string, string>, skipped: RestoreSkipped): ScheduledTask[] {
  const schedules: ScheduledTask[] = [];
  for (const item of array(raw)) {
    const schedule = isObject(item) ? validSchedule(item.schedule) : null;
    if (!isObject(item) || !schedule || typeof item.task !== "string" || !item.task.trim()) {
      skipped.unreadable += 1;
      continue;
    }
    if (!checkSensitive(item.task).allowed) {
      skipped.secret += 1;
      continue;
    }
    // A Skill that had to take a new /command keeps running from its schedule.
    let task = item.task.trim().slice(0, 2000);
    const command = /^\/([a-z0-9-]+)/.exec(task);
    if (command && renamed.has(command[1])) task = `/${renamed.get(command[1])}${task.slice(command[0].length)}`;
    schedules.push({
      id: crypto.randomUUID(),
      task,
      schedule,
      enabled: false,
      created_at: isDate(item.created_at) ? item.created_at : new Date().toISOString(),
      ...(isDate(item.last_run_at) ? { last_run_at: item.last_run_at } : {}),
      ...(SCHEDULE_STATUSES.has(item.last_status as string) ? { last_status: item.last_status as ScheduledTask["last_status"] } : {}),
      ...(typeof item.last_result === "string" ? { last_result: redactSecrets(item.last_result, 2000) } : {}),
      ...(isChatApp(item.deliver_to) ? { deliver_to: item.deliver_to } : {}),
      space_id: newId
    });
  }
  return schedules;
}

function emptySkipped(): RestoreSkipped {
  return { secret: 0, every_space: 0, unreadable: 0, over_limit: 0, schedules_no_room: 0 };
}

/** Both versions, read the same way; a v1 file simply has no shared-store records. */
function normalized(backup: SpaceBackup): { name: string; color: string; sourceId?: string; data: SpaceBackupV2["data"] } {
  if (backup.version === 2) {
    const data = isObject(backup.data) ? backup.data : ({} as SpaceBackupV2["data"]);
    return {
      name: backup.source_space.name,
      color: text(backup.source_space.color, 20),
      sourceId: typeof backup.source_space.id === "string" && backup.source_space.id ? backup.source_space.id : undefined,
      data: { scoped: isObject(data.scoped) ? data.scoped : {}, tagged: isObject(data.tagged) ? data.tagged : {}, schedules: data.schedules }
    };
  }
  const data = isObject(backup.data) ? backup.data : {};
  return {
    name: backup.space.name,
    color: text(backup.space.color, 20),
    data: { scoped: { chats: data.chats, aboutMe: data.aboutMe, instructions: data.instructions, history: data.history }, tagged: {} }
  };
}

/** Checks and cleans everything, with new ids and links, before anything is written. */
function plan(data: SpaceBackupV2["data"], sourceId: string | undefined, newId: string): Plan & { renamedFrom: Map<string, string> } {
  const skipped = emptySkipped();
  const mapSpace = spaceMapper(sourceId, newId);
  const { episodes, sessions } = restoreEpisodes(data.tagged.episodes, newId, skipped);
  const chats = restoreChats(data.scoped.chats, skipped);
  const facts = restoreFacts(data.scoped.aboutMe, mapSpace, newId, skipped);
  const instructions = restoreInstructions(data.scoped.instructions, skipped);
  const history = restoreHistory(data.scoped.history, sessions, skipped);
  const decisions = restoreDecisions(data.tagged.decisions, mapSpace, newId, skipped);
  const { skills } = restoreSkills(data.tagged.skills, mapSpace, newId, skipped);
  const scoped: Record<string, unknown> = {};
  if (data.scoped.chats !== undefined) scoped[keyForSpace(SPACE_SCOPED_KEYS.chats, newId)] = chats;
  if (data.scoped.aboutMe !== undefined) scoped[keyForSpace(SPACE_SCOPED_KEYS.aboutMe, newId)] = facts;
  if (instructions !== undefined) scoped[keyForSpace(SPACE_SCOPED_KEYS.instructions, newId)] = instructions;
  if (data.scoped.history !== undefined) scoped[keyForSpace(SPACE_SCOPED_KEYS.history, newId)] = history;
  return {
    scoped,
    skills,
    decisions,
    episodes,
    schedules: [],
    renamedFrom: new Map(),
    restored: {
      chats: chats.length,
      facts: facts.filter(isCurrent).length,
      earlier_facts: facts.filter((fact) => !isCurrent(fact)).length,
      instructions: Boolean(instructions),
      history: history.length,
      decisions: decisions.filter(isCurrent).length,
      earlier_decisions: decisions.filter((decision) => !isCurrent(decision)).length,
      skills: skills.length,
      episodes: episodes.length,
      schedules: 0
    },
    skipped
  };
}

function nameFor(source: string, spaces: Space[]): string {
  const base = cleanSpaceName(source) || "Restored";
  const taken = new Set(spaces.map((space) => space.name.toLowerCase()));
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = cleanSpaceName(`${base.slice(0, 34)} (${n})`);
  return name;
}

/** Plain-words notes for what didn't come back. */
function warningsFor(skipped: RestoreSkipped): string[] {
  const notes: string[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (skipped.secret) notes.push(`${plural(skipped.secret, "thing was", "things were")} left out because ${skipped.secret === 1 ? "it" : "they"} looked like a password, code or other secret.`);
  if (skipped.every_space) notes.push(`${plural(skipped.every_space, "item was", "items were")} marked for every Space, so ${skipped.every_space === 1 ? "it was" : "they were"} left out. A Space backup only brings back the Space's own things.`);
  if (skipped.unreadable) notes.push(`${plural(skipped.unreadable, "item", "items")} in the file couldn't be read and ${skipped.unreadable === 1 ? "was" : "were"} left out.`);
  if (skipped.over_limit) notes.push(`${plural(skipped.over_limit, "older item was", "older items were")} left out because a Space can only keep so many.`);
  if (skipped.schedules_no_room) notes.push(`${plural(skipped.schedules_no_room, "scheduled task wasn't", "scheduled tasks weren't")} brought back: you can have up to ${MAX_SCHEDULES} in all, and your existing ones were kept.`);
  return notes;
}

/**
 * Brings a backup back as a new Space beside the others; nothing that exists
 * now is changed or pushed out. Everything is checked and prepared first,
 * then written in one go; if writing fails, the new Space and everything
 * written for it are removed again.
 */
export async function restoreSpace(backup: SpaceBackup, options: { reserved?: string[] } = {}): Promise<RestoreResult> {
  const source = normalized(backup);
  const { spaces } = await loadSpaces();
  if (spaces.length >= MAX_SPACES) return { ok: false, error: `You can have up to ${MAX_SPACES} Spaces. Delete one you no longer use first.` };
  const started = performance.now();
  let newId = crypto.randomUUID().slice(0, 8);
  while (spaces.some((space) => space.id === newId)) newId = crypto.randomUUID().slice(0, 8);
  const prepared = plan(source.data, source.sourceId, newId);
  const prepared_ms = performance.now() - started;

  const created = await createSpace(nameFor(source.name, spaces), {
    switchTo: false,
    id: newId,
    ...(SPACE_COLORS.includes(source.color) ? { color: source.color } : {})
  });
  if (!created.ok) return created;

  try {
    // Read the shared stores only now, right before the one write, so nothing saved meanwhile is lost.
    const reserved = options.reserved ?? BUILT_IN_COMMANDS.map((command) => command.name);
    const currentSkills = array(await storeValue(SPACE_TAGGED_KEYS.skills)) as UserSkill[];
    const renamed = new Map<string, string>();
    const assigned: string[] = [];
    const skills = prepared.skills.map((skill) => {
      const base = skillSlug(skill.slug || skill.name);
      // The original keeps its /command; the copy takes the next free one if it is taken.
      const slug = uniqueSlug(base, [...reserved, ...assigned], undefined, currentSkills);
      assigned.push(slug);
      if (slug !== skill.slug) renamed.set(skill.slug, slug);
      return { ...skill, slug };
    });
    const currentSchedules = array(await storeValue(SCHEDULES_KEY));
    const schedules = restoreSchedules(source.data.schedules, newId, renamed, prepared.skipped);
    const room = Math.max(0, MAX_SCHEDULES - currentSchedules.length);
    const fitting = schedules.slice(0, room);
    prepared.skipped.schedules_no_room += schedules.length - fitting.length;
    const currentDecisions = array(await storeValue(SPACE_TAGGED_KEYS.decisions)) as Decision[];
    const currentEpisodes = array(await storeValue(SPACE_TAGGED_KEYS.episodes));

    const values: Record<string, unknown> = { ...prepared.scoped };
    // The new Space's records were already capped to its own shelf, so they are added in front and nothing else is touched.
    if (skills.length) values[SPACE_TAGGED_KEYS.skills] = [...skills, ...currentSkills];
    if (prepared.decisions.length) values[SPACE_TAGGED_KEYS.decisions] = [...prepared.decisions, ...currentDecisions];
    if (prepared.episodes.length) values[SPACE_TAGGED_KEYS.episodes] = [...prepared.episodes, ...currentEpisodes];
    if (fitting.length) values[SCHEDULES_KEY] = [...currentSchedules, ...fitting];
    await chrome.storage.local.set(values);

    // Check what was written before calling it done.
    const counted = await spaceContents(newId);
    if (counted.skills !== skills.length || counted.episodes !== prepared.episodes.length || counted.schedules !== fitting.length || counted.chats !== prepared.restored.chats) {
      throw new Error("The restored Space didn't read back as written.");
    }
    return {
      ok: true,
      space: created.space,
      restored: { ...prepared.restored, schedules: fitting.length },
      skipped: prepared.skipped,
      renamed_commands: [...renamed].map(([from, to]) => ({ from, to })),
      warnings: warningsFor(prepared.skipped),
      timings: { prepare_ms: Math.round(prepared_ms), write_ms: Math.round(performance.now() - started - prepared_ms) }
    };
  } catch {
    // Never leave a half-restored Space: it goes, with everything written for it.
    await deleteSpace(newId).catch(() => undefined);
    return { ok: false, error: "The backup couldn't be brought back, so nothing was changed. Try again, or check that the file isn't damaged." };
  }
}

/** The plain summary shown after a restore. */
export function restoreSummary(result: Extract<RestoreResult, { ok: true }>): string[] {
  const r = result.restored;
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const lines = [
    r.chats ? plural(r.chats, "chat") : "",
    r.facts || r.earlier_facts ? `${plural(r.facts, "remembered fact")}${r.earlier_facts ? ` (and ${r.earlier_facts} from before)` : ""}` : "",
    r.instructions ? "your wishes for this Space" : "",
    r.decisions || r.earlier_decisions ? `${plural(r.decisions, "decision")}${r.earlier_decisions ? ` (and ${r.earlier_decisions} earlier)` : ""}` : "",
    r.skills ? plural(r.skills, "Skill") : "",
    r.history ? `${plural(r.history, "past task")}${r.episodes ? ` (${r.episodes} with what was checked along the way)` : ""}` : r.episodes ? plural(r.episodes, "task record") : "",
    r.schedules ? `${plural(r.schedules, "scheduled task")} (paused until you turn ${r.schedules === 1 ? "it" : "them"} on)` : ""
  ].filter(Boolean);
  return lines;
}
