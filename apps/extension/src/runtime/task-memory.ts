import type {
  BrowserSessionPageContext,
  BrowserTaskSessionEvidence
} from "./session-evidence";

const KEY = "browsercrew.taskEpisodes.v1";
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
  boundary_action_id?: string;
  sensitive_payloads_removed: true;
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

export function taskEpisodeFromSession(
  evidence: BrowserTaskSessionEvidence,
  recordedAt = new Date().toISOString()
): TaskEpisodeMemory {
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
      ...evidence.tab_evidence.map((item) => item.url)
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
    ...(evidence.boundary_action_id
      ? { boundary_action_id: evidence.boundary_action_id }
      : {}),
    sensitive_payloads_removed: true
  };
}

async function loadEpisodes(): Promise<TaskEpisodeMemory[]> {
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

export async function saveTaskEpisodeMemory(
  evidence: BrowserTaskSessionEvidence
): Promise<TaskEpisodeMemory> {
  const episode = taskEpisodeFromSession(evidence);
  const current = await loadEpisodes();
  const next = [
    episode,
    ...current.filter((item) => item.id !== episode.id)
  ].slice(0, MAX_EPISODES);
  await chrome.storage.local.set({ [KEY]: next });
  return structuredClone(episode);
}

export async function listTaskEpisodeMemory(
  limit = 50
): Promise<TaskEpisodeMemory[]> {
  const boundedLimit = Math.min(
    Math.max(Math.round(Number(limit) || 50), 1),
    100
  );
  return (await loadEpisodes())
    .slice(0, boundedLimit)
    .map((item) => structuredClone(item));
}

export async function getTaskEpisodeMemory(
  id: string
): Promise<TaskEpisodeMemory | null> {
  const found = (await loadEpisodes()).find(
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
    ])
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
  limit = 10
): Promise<TaskEpisodeMemory[]> {
  const boundedLimit = Math.min(
    Math.max(Math.round(Number(limit) || 10), 1),
    25
  );

  return (await loadEpisodes())
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

export async function deleteTaskEpisodeMemory(
  id: string
): Promise<boolean> {
  const current = await loadEpisodes();
  const next = current.filter((item) => item.id !== id);
  if (next.length === current.length) return false;
  await chrome.storage.local.set({ [KEY]: next });
  return true;
}

export const TASK_EPISODE_MEMORY_KEY = KEY;
