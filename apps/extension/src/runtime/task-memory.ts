import type {
  BrowserSessionPageContext,
  BrowserTaskSessionEvidence
} from "./session-evidence";
import { resolveSpace, withinSpace } from "./memory-scope";

const KEY = "browserharness.taskEpisodes.v1";
/** Kept per Space. */
const MAX_EPISODES = 500;
const MAX_TEXT = 1000;
const MAX_TARGETS = 40;
const MAX_SITES = 20;
const MAX_SKILL_REFS = 20;

export interface TaskEpisodeSkillRef {
  id: string;
  action: string;
  revision_id?: string;
}

export interface TaskEpisodeDelegation {
  action_id: string;
  worker_index: number;
  task: string;
  session_id: string;
  status:
    | "completed"
    | "stopped"
    | "approval-cancelled"
    | "failed";
  sources: Array<{
    url: string;
    title: string;
  }>;
  tools_used: string[];
}

export interface TaskEpisodeMemory {
  schema_version: 1;
  id: string;
  kind: "task_episode";
  recorded_at: string;
  session_id: string;
  title: string;
  task: string;
  status: BrowserTaskSessionEvidence["status"];
  start: BrowserSessionPageContext;
  end?: BrowserSessionPageContext;
  action_count: number;
  manual_handoff_count: number;
  tools: string[];
  targets: string[];
  sites: string[];
  skill_refs: TaskEpisodeSkillRef[];
  delegations?: TaskEpisodeDelegation[];
  boundary_action_id?: string;
  sensitive_payloads_removed: true;
  /**
   * The Space the task ran in. Helpers' findings (delegations) belong to it
   * too. Episodes saved before Spaces have none and count as the first Space.
   */
  space_id?: string;
}

function bounded(value: string, max = MAX_TEXT): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function unique(values: string[], limit: number): string[] {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

function endContext(
  evidence: BrowserTaskSessionEvidence
): BrowserSessionPageContext | undefined {
  const actionAfter = [...evidence.actions]
    .reverse()
    .find((action) => action.after)?.after;
  if (actionAfter) return structuredClone(actionAfter);

  const handoffAfter = [...(evidence.manual_handoffs || [])]
    .reverse()
    .find((handoff) => handoff.after)?.after;
  if (handoffAfter) return structuredClone(handoffAfter);

  const lastTab = evidence.tab_evidence.at(-1);
  return lastTab
    ? {
        tab_id: lastTab.tab_id,
        url: lastTab.url,
        title: lastTab.title
      }
    : undefined;
}

function skillRefs(
  evidence: BrowserTaskSessionEvidence
): TaskEpisodeSkillRef[] {
  const refs: TaskEpisodeSkillRef[] = [];

  for (const action of evidence.actions) {
    if (action.tool !== "site_skill") continue;
    const id =
      typeof action.input.id === "string"
        ? action.input.id
        : "";
    const skillAction =
      typeof action.input.action === "string"
        ? action.input.action
        : "";
    if (!id || !skillAction) continue;

    refs.push({
      id,
      action: skillAction,
      ...(typeof action.input.revision_id === "string"
        ? { revision_id: action.input.revision_id }
        : {})
    });
  }

  return refs
    .filter(
      (item, index, array) =>
        array.findIndex(
          (candidate) =>
            candidate.id === item.id &&
            candidate.action === item.action &&
            candidate.revision_id === item.revision_id
        ) === index
    )
    .slice(0, MAX_SKILL_REFS);
}

function delegations(
  evidence: BrowserTaskSessionEvidence
): TaskEpisodeDelegation[] {
  return evidence.actions
    .flatMap((action) =>
      (action.delegation?.workers || []).map(
        (worker): TaskEpisodeDelegation => ({
          action_id: action.id,
          worker_index: worker.index,
          task: bounded(worker.task),
          session_id: worker.session_id,
          status: worker.status,
          sources: worker.sources
            .slice(0, 6)
            .map((source) => ({
              url: source.url,
              title: bounded(source.title, 240)
            })),
          tools_used: unique(
            worker.tools_used,
            20
          )
        })
      )
    )
    .slice(0, 20);
}

export function taskEpisodeFromSession(
  evidence: BrowserTaskSessionEvidence,
  recordedAt = new Date().toISOString(),
  spaceId?: string
): TaskEpisodeMemory {
  const delegated = delegations(evidence);
  const tools = unique(
    evidence.actions.map((action) => action.tool),
    50
  );
  const targets = unique(
    evidence.actions
      .map((action) =>
        action.target?.accessible_name
          ? bounded(action.target.accessible_name, 160)
          : ""
      ),
    MAX_TARGETS
  );
  const sites = unique(
    [
      evidence.start.url,
      ...evidence.actions.flatMap((action) => [
        action.before.url,
        action.after?.url || ""
      ]),
      ...evidence.tab_evidence.map((item) => item.url),
      ...delegated.flatMap((item) =>
        item.sources.map((source) => source.url)
      )
    ].map(origin),
    MAX_SITES
  );

  return {
    schema_version: 1,
    id: `episode:${evidence.session_id}:${evidence.started_at}`,
    kind: "task_episode",
    recorded_at: recordedAt,
    session_id: evidence.session_id,
    title: bounded(evidence.title, 160),
    task: bounded(evidence.task),
    status: evidence.status,
    start: structuredClone(evidence.start),
    ...(endContext(evidence)
      ? { end: endContext(evidence) }
      : {}),
    action_count: evidence.actions.length,
    manual_handoff_count:
      evidence.manual_handoffs?.length || 0,
    tools,
    targets,
    sites,
    skill_refs: skillRefs(evidence),
    ...(delegated.length
      ? { delegations: delegated }
      : {}),
    ...(evidence.boundary_action_id
      ? { boundary_action_id: evidence.boundary_action_id }
      : {}),
    sensitive_payloads_removed: true,
    ...(spaceId ? { space_id: spaceId } : {})
  };
}

async function loadAllEpisodes(): Promise<TaskEpisodeMemory[]> {
  const stored = await chrome.storage.local.get(KEY);
  return Array.isArray(stored[KEY])
    ? (stored[KEY] as TaskEpisodeMemory[]).filter(
        (item) =>
          item &&
          item.schema_version === 1 &&
          item.kind === "task_episode"
      )
    : [];
}

/** Only the episodes of one Space: the wall is applied before anything is searched. */
/** How many stored episodes sit behind the wall for this Space (counted by tag only, never read or scored). */
export async function countEpisodesOutsideSpace(spaceId: string): Promise<number> {
  const all = await loadAllEpisodes();
  return all.length - withinSpace(all, spaceId).length;
}

async function loadEpisodes(spaceId?: string): Promise<TaskEpisodeMemory[]> {
  return withinSpace(await loadAllEpisodes(), await resolveSpace(spaceId));
}

export async function saveTaskEpisodeMemory(
  evidence: BrowserTaskSessionEvidence,
  spaceId?: string
): Promise<TaskEpisodeMemory> {
  const episode = taskEpisodeFromSession(
    evidence,
    undefined,
    await resolveSpace(spaceId)
  );
  const space = episode.space_id!;
  const current = (await loadAllEpisodes()).filter(
    (item) => item.id !== episode.id
  );
  // The limit is per Space: a busy Space never pushes out another's episodes.
  const own = [
    episode,
    ...withinSpace(current, space)
  ];
  const dropped = new Set(
    own.slice(MAX_EPISODES).map((item) => item.id)
  );
  const next = [episode, ...current].filter(
    (item) => !dropped.has(item.id)
  );
  await chrome.storage.local.set({ [KEY]: next });
  return structuredClone(episode);
}

export async function listTaskEpisodeMemory(
  limit = 50,
  spaceId?: string
): Promise<TaskEpisodeMemory[]> {
  const boundedLimit = Math.min(
    Math.max(Math.round(Number(limit) || 50), 1),
    100
  );
  return (await loadEpisodes(spaceId))
    .slice(0, boundedLimit)
    .map((item) => structuredClone(item));
}

export async function getTaskEpisodeMemory(
  id: string,
  spaceId?: string
): Promise<TaskEpisodeMemory | null> {
  const found = (await loadEpisodes(spaceId)).find(
    (item) => item.id === id
  );
  return found ? structuredClone(found) : null;
}

function tokens(value: string): string[] {
  return [...new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9._:/-]+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2)
  )];
}

function searchScore(
  episode: TaskEpisodeMemory,
  query: string
): number {
  const queryText = bounded(query, 500).toLowerCase();
  const queryTokens = tokens(queryText);
  if (!queryTokens.length) return 0;

  const haystack = [
    episode.title,
    episode.task,
    episode.status,
    ...episode.tools,
    ...episode.targets,
    ...episode.sites,
    ...episode.skill_refs.flatMap((ref) => [
      ref.id,
      ref.action,
      ref.revision_id || ""
    ]),
    ...(episode.delegations || []).flatMap(
      (delegation) => [
        delegation.task,
        delegation.session_id,
        delegation.status,
        ...delegation.tools_used,
        ...delegation.sources.flatMap((source) => [
          source.url,
          source.title
        ])
      ]
    )
  ]
    .join(" ")
    .toLowerCase();

  let score = haystack.includes(queryText) ? 100 : 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) score += 10;
    if (episode.task.toLowerCase().includes(token)) score += 5;
    if (episode.title.toLowerCase().includes(token)) score += 5;
  }
  return score;
}

export async function searchTaskEpisodeMemory(
  query: string,
  limit = 10,
  spaceId?: string
): Promise<TaskEpisodeMemory[]> {
  const boundedLimit = Math.min(
    Math.max(Math.round(Number(limit) || 10), 1),
    25
  );

  return (await loadEpisodes(spaceId))
    .map((episode) => ({
      episode,
      score: searchScore(episode, query)
    }))
    .filter((item) => item.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.episode.recorded_at.localeCompare(
          left.episode.recorded_at
        )
    )
    .slice(0, boundedLimit)
    .map((item) => structuredClone(item.episode));
}

/** Deletes an episode of this Space only; the same id in another Space is never touched. */
export async function deleteTaskEpisodeMemory(
  id: string,
  spaceId?: string
): Promise<boolean> {
  const space = await resolveSpace(spaceId);
  const current = await loadAllEpisodes();
  const next = current.filter(
    (item) =>
      !(item.id === id && withinSpace([item], space).length)
  );
  if (next.length === current.length) return false;
  await chrome.storage.local.set({ [KEY]: next });
  return true;
}

export const TASK_EPISODE_MEMORY_KEY = KEY;
