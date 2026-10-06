// Tasks sent from a chat app (Telegram, Discord, Slack, Signal…). The service
// worker queues each message and opens a runner page for it. The Space is
// captured the moment the message is accepted, so a task always works in the
// Space that was in use when it arrived, even if the person switches before
// the runner page starts.
//
// Kept free of the task-running code so the service worker can import it.
import { activeSpaceId } from "./spaces";

export const REMOTE_TASKS_KEY = "browserharness.remoteTasks";

export interface RemoteTaskRequest {
  text: string;
  from: string;
  /** The Space in use when the message arrived. Older queued requests may not have one. */
  space_id?: string;
  created_at: string;
}

export const CHAT_APP_NAMES: Record<string, string> = {
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
  signal: "Signal",
  mattermost: "Mattermost",
  matrix: "Matrix",
  email: "email"
};

async function loadQueue(): Promise<Record<string, RemoteTaskRequest>> {
  return ((await chrome.storage.session.get(REMOTE_TASKS_KEY))[REMOTE_TASKS_KEY] || {}) as Record<string, RemoteTaskRequest>;
}

/** Queues a message as a task in the Space in use right now; returns its id. */
export async function enqueueRemoteTask(text: string, from: string): Promise<string> {
  const id = crypto.randomUUID();
  const request: RemoteTaskRequest = {
    text,
    from,
    space_id: await activeSpaceId(),
    created_at: new Date().toISOString()
  };
  await chrome.storage.session.set({ [REMOTE_TASKS_KEY]: { ...(await loadQueue()), [id]: request } });
  return id;
}

/**
 * Takes a queued task off the queue, with its Space settled: the one it was
 * queued in, or (for a request queued before Spaces were recorded) the one in
 * use now.
 */
export async function takeRemoteTask(id: string): Promise<(RemoteTaskRequest & { space_id: string }) | null> {
  const queue = await loadQueue();
  const request = queue[id];
  if (!request) return null;
  const { [id]: _taken, ...rest } = queue;
  await chrome.storage.session.set({ [REMOTE_TASKS_KEY]: rest });
  return { ...request, space_id: request.space_id || (await activeSpaceId()) };
}
