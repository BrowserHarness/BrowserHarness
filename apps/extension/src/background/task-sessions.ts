export interface TaskSession {
  id: string;
  title: string;
  created_at: string;
  current_tab_id?: number;
  owned_tab_ids: number[];
  borrowed_tab_ids: number[];
  group_id?: number;
}

const STORAGE_KEY = "browsercrew.taskSessions";
const MAX_SESSIONS = 20;

async function loadAll(): Promise<Record<string, TaskSession>> {
  const stored = await chrome.storage.session.get(STORAGE_KEY);
  return (stored[STORAGE_KEY] as Record<string, TaskSession> | undefined) || {};
}

async function saveAll(sessions: Record<string, TaskSession>): Promise<void> {
  const ordered = Object.values(sessions)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, MAX_SESSIONS);
  await chrome.storage.session.set({
    [STORAGE_KEY]: Object.fromEntries(
      ordered.map((session) => [session.id, session])
    )
  });
}

export async function ensureTaskSession(
  id: string,
  title: string
): Promise<TaskSession> {
  const sessions = await loadAll();
  const existing = sessions[id];
  if (existing) return existing;

  const created: TaskSession = {
    id,
    title,
    created_at: new Date().toISOString(),
    owned_tab_ids: [],
    borrowed_tab_ids: []
  };
  sessions[id] = created;
  await saveAll(sessions);
  return created;
}

export async function updateTaskSession(
  session: TaskSession
): Promise<void> {
  const sessions = await loadAll();
  sessions[session.id] = session;
  await saveAll(sessions);
}

export async function getTaskSession(
  id: string
): Promise<TaskSession | null> {
  const sessions = await loadAll();
  return sessions[id] || null;
}

export async function borrowTab(
  session: TaskSession,
  tabId: number
): Promise<TaskSession> {
  const next: TaskSession = {
    ...session,
    current_tab_id: tabId,
    borrowed_tab_ids: session.borrowed_tab_ids.includes(tabId)
      ? session.borrowed_tab_ids
      : [...session.borrowed_tab_ids, tabId]
  };
  await updateTaskSession(next);
  return next;
}

export async function ownTab(
  session: TaskSession,
  tabId: number
): Promise<TaskSession> {
  const next: TaskSession = {
    ...session,
    current_tab_id: tabId,
    owned_tab_ids: session.owned_tab_ids.includes(tabId)
      ? session.owned_tab_ids
      : [...session.owned_tab_ids, tabId]
  };
  await updateTaskSession(next);
  return next;
}

export async function selectSessionTab(
  session: TaskSession,
  tabId: number
): Promise<TaskSession> {
  const belongs =
    session.owned_tab_ids.includes(tabId) ||
    session.borrowed_tab_ids.includes(tabId);
  if (!belongs) {
    throw new Error("Tab is not part of this BrowserCrew task session");
  }

  const next = { ...session, current_tab_id: tabId };
  await updateTaskSession(next);
  return next;
}

export async function setSessionGroup(
  session: TaskSession,
  groupId: number
): Promise<TaskSession> {
  const next = { ...session, group_id: groupId };
  await updateTaskSession(next);
  return next;
}

export async function removeSessionTab(
  session: TaskSession,
  tabId: number
): Promise<TaskSession> {
  const owned = session.owned_tab_ids.filter((id) => id !== tabId);
  const borrowed = session.borrowed_tab_ids.filter((id) => id !== tabId);
  const next: TaskSession = {
    ...session,
    owned_tab_ids: owned,
    borrowed_tab_ids: borrowed,
    current_tab_id:
      session.current_tab_id === tabId
        ? owned.at(-1) ?? borrowed.at(-1)
        : session.current_tab_id
  };
  await updateTaskSession(next);
  return next;
}

export async function closeTaskSession(
  session: TaskSession
): Promise<number> {
  const tabs = [...session.owned_tab_ids];
  if (tabs.length) {
    await chrome.tabs.remove(tabs).catch(() => undefined);
  }

  const sessions = await loadAll();
  delete sessions[session.id];
  await saveAll(sessions);
  return tabs.length;
}
