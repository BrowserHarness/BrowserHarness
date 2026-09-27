import type {
  RecordedWorkflowStep,
  WorkflowRecordingEvent,
  WorkflowRecordingSummary
} from "../runtime/workflows";

const STORAGE_KEY = "browsercrew.watchRecording";
const MAX_STEPS = 1_000;
const MAX_EVENTS = 2_000;
const MAX_TABS = 50;
const MAX_APPROXIMATE_BYTES = 2_000_000;

let writeQueue: Promise<void> = Promise.resolve();

export interface WatchRecordingSession {
  id: string;
  started_at: string;
  root_tab_id: number;
  current_tab_id: number;
  start_url: string;
  start_title?: string;
  tab_ids: number[];
  steps: RecordedWorkflowStep[];
  events: WorkflowRecordingEvent[];
  boundary_step_id?: string;
  approximate_bytes: number;
  dropped_steps: number;
  dropped_events: number;
}

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(operation, operation);
  writeQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function sizeOf(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}

async function load(): Promise<WatchRecordingSession | null> {
  const stored = await chrome.storage.session.get(STORAGE_KEY);
  return (stored[STORAGE_KEY] as WatchRecordingSession | undefined) || null;
}

async function save(session: WatchRecordingSession): Promise<void> {
  await chrome.storage.session.set({
    [STORAGE_KEY]: session
  });
}

async function mutate(
  operation: (
    session: WatchRecordingSession
  ) => WatchRecordingSession
): Promise<WatchRecordingSession | null> {
  return serialize(async () => {
    const current = await load();
    if (!current) return null;

    const next = operation(current);
    await save(next);
    return next;
  });
}

function withTab(
  session: WatchRecordingSession,
  tabId: number
): WatchRecordingSession {
  if (session.tab_ids.includes(tabId)) return session;
  if (session.tab_ids.length >= MAX_TABS) return session;

  return {
    ...session,
    tab_ids: [...session.tab_ids, tabId]
  };
}

export async function startWatchRecording(
  tab: chrome.tabs.Tab
): Promise<WatchRecordingSession> {
  if (typeof tab.id !== "number") {
    throw new Error("Recording requires a real browser tab");
  }

  return serialize(async () => {
    const now = new Date().toISOString();
    const session: WatchRecordingSession = {
      id: crypto.randomUUID(),
      started_at: now,
      root_tab_id: tab.id!,
      current_tab_id: tab.id!,
      start_url: tab.url || "",
      start_title: tab.title,
      tab_ids: [tab.id!],
      steps: [],
      events: [
        {
          id: crypto.randomUUID(),
          type: "tab_activated",
          recorded_at: now,
          tab_id: tab.id!,
          window_id: tab.windowId,
          url: tab.url,
          title: tab.title
        }
      ],
      approximate_bytes: 0,
      dropped_steps: 0,
      dropped_events: 0
    };
    session.approximate_bytes = sizeOf(session.events[0]);
    await save(session);
    return session;
  });
}

export async function getWatchRecording(): Promise<WatchRecordingSession | null> {
  return load();
}

export async function appendWatchStep(
  tabId: number,
  step: RecordedWorkflowStep
): Promise<{
  accepted: boolean;
  session: WatchRecordingSession | null;
}> {
  let accepted = false;

  const session = await mutate((current) => {
    let next = withTab(current, tabId);
    const normalized: RecordedWorkflowStep = {
      ...step,
      id: step.id || crypto.randomUUID(),
      recorded_at: step.recorded_at || new Date().toISOString(),
      tab_id: tabId
    };

    const bytes = sizeOf(normalized);
    if (
      next.steps.length >= MAX_STEPS ||
      next.approximate_bytes + bytes > MAX_APPROXIMATE_BYTES
    ) {
      return {
        ...next,
        dropped_steps: next.dropped_steps + 1
      };
    }

    accepted = true;
    next = {
      ...next,
      current_tab_id: tabId,
      steps: [...next.steps, normalized],
      boundary_step_id: normalized.id,
      approximate_bytes: next.approximate_bytes + bytes
    };
    return next;
  });

  return { accepted, session };
}

export async function appendWatchEvent(
  event: Omit<WorkflowRecordingEvent, "id" | "recorded_at"> & {
    id?: string;
    recorded_at?: string;
  }
): Promise<WatchRecordingSession | null> {
  return mutate((current) => {
    let next = withTab(current, event.tab_id);

    const normalized = {
      ...event,
      id: event.id || crypto.randomUUID(),
      recorded_at: event.recorded_at || new Date().toISOString()
    } as WorkflowRecordingEvent;

    const bytes = sizeOf(normalized);
    if (
      next.events.length >= MAX_EVENTS ||
      next.approximate_bytes + bytes > MAX_APPROXIMATE_BYTES
    ) {
      return {
        ...next,
        dropped_events: next.dropped_events + 1
      };
    }

    return {
      ...next,
      current_tab_id:
        normalized.type === "tab_activated"
          ? normalized.tab_id
          : next.current_tab_id,
      events: [...next.events, normalized],
      approximate_bytes: next.approximate_bytes + bytes
    };
  });
}

export async function trackWatchTab(
  tabId: number
): Promise<WatchRecordingSession | null> {
  return mutate((current) => withTab(current, tabId));
}

export async function markWatchTabClosed(
  tabId: number
): Promise<WatchRecordingSession | null> {
  return mutate((current) => ({
    ...current,
    current_tab_id:
      current.current_tab_id === tabId
        ? current.root_tab_id
        : current.current_tab_id
  }));
}

export async function stopWatchRecording(): Promise<WatchRecordingSession | null> {
  return serialize(async () => {
    const session = await load();
    await chrome.storage.session.remove(STORAGE_KEY);
    return session;
  });
}

export function watchRecordingSummary(
  session: WatchRecordingSession
): WorkflowRecordingSummary {
  return {
    tab_count: session.tab_ids.length,
    event_count: session.events.length,
    dropped_steps: session.dropped_steps,
    dropped_events: session.dropped_events,
    approximate_bytes: session.approximate_bytes
  };
}

export function watchRecordingLimits() {
  return {
    max_steps: MAX_STEPS,
    max_events: MAX_EVENTS,
    max_tabs: MAX_TABS,
    max_approximate_bytes: MAX_APPROXIMATE_BYTES
  };
}
