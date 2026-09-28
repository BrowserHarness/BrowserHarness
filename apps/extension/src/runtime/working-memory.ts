import type {
  BrowserSessionActionEvidence,
  BrowserSessionManualHandoffEvidence,
  BrowserSessionPageContext
} from "./session-evidence";

const KEY = "browsercrew.workingMemory.v1";
const MAX_SESSIONS = 20;
const MAX_RECENT_ACTIONS = 12;
const MAX_HANDOFFS = 5;
const MAX_SITES = 20;
const MAX_TEXT = 500;

export interface BrowserWorkingMemoryAction {
  ordinal: number;
  tool: string;
  note: string;
  target?: string;
  before: BrowserSessionPageContext;
  after?: BrowserSessionPageContext;
}

export interface BrowserWorkingMemorySkillRef {
  id: string;
  action: string;
  revision_id?: string;
}

export interface BrowserWorkingMemory {
  schema_version: 1;
  session_id: string;
  title: string;
  task: string;
  started_at: string;
  updated_at: string;
  status: "active";
  current: BrowserSessionPageContext;
  action_count: number;
  recent_actions: BrowserWorkingMemoryAction[];
  manual_handoffs: Array<{
    reason: string;
    status: "continued" | "cancelled";
    source: "navigation" | "user";
  }>;
  sites: string[];
  skill_refs: BrowserWorkingMemorySkillRef[];
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

function skillRefs(
  actions: BrowserSessionActionEvidence[]
): BrowserWorkingMemorySkillRef[] {
  const refs: BrowserWorkingMemorySkillRef[] = [];

  for (const action of actions) {
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

  return refs.filter(
    (item, index, array) =>
      array.findIndex(
        (candidate) =>
          candidate.id === item.id &&
          candidate.action === item.action &&
          candidate.revision_id === item.revision_id
      ) === index
  );
}

export function buildBrowserWorkingMemory(input: {
  session_id: string;
  title: string;
  task: string;
  started_at: string;
  current: BrowserSessionPageContext;
  actions: BrowserSessionActionEvidence[];
  manual_handoffs?: BrowserSessionManualHandoffEvidence[];
  updated_at?: string;
}): BrowserWorkingMemory {
  const recentActions = input.actions
    .slice(-MAX_RECENT_ACTIONS)
    .map((action) => ({
      ordinal: action.ordinal,
      tool: action.tool,
      note: bounded(action.note, 240),
      ...(action.target?.accessible_name
        ? {
            target: bounded(
              action.target.accessible_name,
              160
            )
          }
        : {}),
      before: structuredClone(action.before),
      ...(action.after
        ? { after: structuredClone(action.after) }
        : {})
    }));

  const sites = [
    input.current.url,
    ...input.actions.flatMap((action) => [
      action.before.url,
      action.after?.url || ""
    ])
  ]
    .map(origin)
    .filter(Boolean);

  return {
    schema_version: 1,
    session_id: input.session_id,
    title: bounded(input.title, 160),
    task: bounded(input.task),
    started_at: input.started_at,
    updated_at: input.updated_at || new Date().toISOString(),
    status: "active",
    current: structuredClone(input.current),
    action_count: input.actions.length,
    recent_actions: recentActions,
    manual_handoffs: (input.manual_handoffs || [])
      .slice(-MAX_HANDOFFS)
      .map((handoff) => ({
        reason: bounded(handoff.reason, 240),
        status: handoff.status,
        source: handoff.source
      })),
    sites: [...new Set(sites)].slice(0, MAX_SITES),
    skill_refs: skillRefs(input.actions),
    sensitive_payloads_removed: true
  };
}

async function loadAll(): Promise<
  Record<string, BrowserWorkingMemory>
> {
  const stored = await chrome.storage.session.get(KEY);
  return (
    (stored[KEY] as
      | Record<string, BrowserWorkingMemory>
      | undefined) || {}
  );
}

export async function saveBrowserWorkingMemory(
  memory: BrowserWorkingMemory
): Promise<void> {
  const all = await loadAll();
  all[memory.session_id] = structuredClone(memory);

  const ordered = Object.values(all)
    .sort((left, right) =>
      right.updated_at.localeCompare(left.updated_at)
    )
    .slice(0, MAX_SESSIONS);

  await chrome.storage.session.set({
    [KEY]: Object.fromEntries(
      ordered.map((item) => [item.session_id, item])
    )
  });
}

export async function getBrowserWorkingMemory(
  sessionId: string
): Promise<BrowserWorkingMemory | null> {
  const all = await loadAll();
  return all[sessionId]
    ? structuredClone(all[sessionId])
    : null;
}

export async function listBrowserWorkingMemory(): Promise<
  BrowserWorkingMemory[]
> {
  return Object.values(await loadAll())
    .sort((left, right) =>
      right.updated_at.localeCompare(left.updated_at)
    )
    .map((item) => structuredClone(item));
}

export async function clearBrowserWorkingMemory(
  sessionId: string
): Promise<boolean> {
  const all = await loadAll();
  if (!all[sessionId]) return false;
  delete all[sessionId];
  await chrome.storage.session.set({ [KEY]: all });
  return true;
}

export const BROWSER_WORKING_MEMORY_KEY = KEY;
