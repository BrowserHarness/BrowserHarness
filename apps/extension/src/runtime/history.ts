import { loadPreferences } from "../settings/preferences";

export interface TaskHistoryEntry {
  id: string;
  task: string;
  result: string;
  timestamp: string;
  url?: string;
}

const HISTORY_KEY = "browserharness.taskHistory";
const MAX_HISTORY = 500;

export async function loadTaskHistory(): Promise<TaskHistoryEntry[]> {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const value = stored[HISTORY_KEY];
  return Array.isArray(value) ? (value as TaskHistoryEntry[]) : [];
}

export async function saveTaskHistoryEntry(
  entry: Omit<TaskHistoryEntry, "id" | "timestamp">
): Promise<void> {
  const preferences = await loadPreferences();
  if (!preferences.retainTaskHistory) return;

  const previous = await loadTaskHistory();
  const next: TaskHistoryEntry = {
    ...entry,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString()
  };
  await chrome.storage.local.set({
    [HISTORY_KEY]: [next, ...previous].slice(0, MAX_HISTORY)
  });
}

export async function clearTaskHistory(): Promise<void> {
  await chrome.storage.local.remove(HISTORY_KEY);
}

/**
 * Past tasks matching every word of the query (task, answer or page),
 * newest first. An empty query returns everything.
 */
export function searchTaskHistory(
  entries: TaskHistoryEntry[],
  query: string
): TaskHistoryEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return entries;
  return entries.filter((entry) => {
    const haystack = `${entry.task}\n${entry.result}\n${entry.url || ""}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
