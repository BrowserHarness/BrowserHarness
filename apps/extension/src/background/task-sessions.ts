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

let writeQueue: Promise<void> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(operation, operation);
  writeQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function loadAll(): Promise<Record<string, TaskSession>> {
  const stored = await chrome.storage.session.get(STORAGE_KEY);
  return (
    (stored[STORAGE_KEY] as Record<string, TaskSession> | undefined) ||
    {}
  );
}

async function saveAll(
  sessions: Record<string, TaskSession>
): Promise<void> {
  const ordered = Object.values(sessions)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, MAX_SESSIONS);

  await chrome.storage.session.set({
    [STORAGE_KEY]: Object.fromEntries(
      ordered.map((session) => [session.id, session])
    )
  });
}

async function mutateSession(
  fallback: TaskSession,
  mutate: (current: TaskSession) => TaskSession
): Promise<TaskSession> {
  return serialize(async () => {
    const sessions = await loadAll();
    const current = sessions[fallback.id] || fallback;
    const next = mutate(current);
    sessions[next.id] = next;
    await saveAll(sessions);
    return next;
  });
}

export async function ensureTaskSession(
  id: string,
  title: string
): Promise<TaskSession> {
  return serialize(async () => {
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
  });
}

export async function updateTaskSession(
  session: TaskSession
): Promise<void> {
  await serialize(async () => {
    const sessions = await loadAll();
    sessions[session.id] = session;
    await saveAll(sessions);
  });
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
  return mutateSession(session, (current) => ({
    ...current,
    current_tab_id: tabId,
    borrowed_tab_ids: current.borrowed_tab_ids.includes(tabId)
      ? current.borrowed_tab_ids
      : [...current.borrowed_tab_ids, tabId]
  }));
}

export async function ownTab(
  session: TaskSession,
  tabId: number
): Promise<TaskSession> {
  return mutateSession(session, (current) => ({
    ...current,
    current_tab_id: tabId,
    owned_tab_ids: current.owned_tab_ids.includes(tabId)
      ? current.owned_tab_ids
      : [...current.owned_tab_ids, tabId]
  }));
}

export async function selectSessionTab(
  session: TaskSession,
  tabId: number
): Promise<TaskSession> {
  return mutateSession(session, (current) => {
    const belongs =
      current.owned_tab_ids.includes(tabId) ||
      current.borrowed_tab_ids.includes(tabId);

    if (!belongs) {
      throw new Error(
        "Tab is not part of this BrowserHarness task session"
      );
    }

    return { ...current, current_tab_id: tabId };
  });
}

export async function setSessionGroup(
  session: TaskSession,
  groupId: number
): Promise<TaskSession> {
  return mutateSession(session, (current) => ({
    ...current,
    group_id: groupId
  }));
}

export async function removeSessionTab(
  session: TaskSession,
  tabId: number
): Promise<TaskSession> {
  return mutateSession(session, (current) => {
    const owned = current.owned_tab_ids.filter((id) => id !== tabId);
    const borrowed = current.borrowed_tab_ids.filter(
      (id) => id !== tabId
    );

    return {
      ...current,
      owned_tab_ids: owned,
      borrowed_tab_ids: borrowed,
      current_tab_id:
        current.current_tab_id === tabId
          ? owned.at(-1) ?? borrowed.at(-1)
          : current.current_tab_id
    };
  });
}

export async function closeTaskSession(
  session: TaskSession
): Promise<number> {
  return serialize(async () => {
    const sessions = await loadAll();
    const current = sessions[session.id] || session;
    const tabs = [...current.owned_tab_ids];

    if (tabs.length) {
      await chrome.tabs.remove(tabs).catch(() => undefined);
    }

    delete sessions[current.id];
    await saveAll(sessions);
    return tabs.length;
  });
}
