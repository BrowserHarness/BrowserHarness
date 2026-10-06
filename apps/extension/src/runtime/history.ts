import { loadPreferences } from "../settings/preferences";
import { keyForSpace, spaceKey, SPACE_SCOPED_KEYS } from "./spaces";

export interface TaskHistoryEntry {
  id: string;
  task: string;
  result: string;
  timestamp: string;
  url?: string;
}

// Each Space keeps its own past conversations (see spaces.ts).
const HISTORY_KEY = SPACE_SCOPED_KEYS.history;
const MAX_HISTORY = 500;

async function historyKey(spaceId?: string): Promise<string> {
  return spaceId ? keyForSpace(HISTORY_KEY, spaceId) : spaceKey(HISTORY_KEY);
}

/** Pass the Space a task started in; without one, the Space in use right now. */
export async function loadTaskHistory(spaceId?: string): Promise<TaskHistoryEntry[]> {
  const key = await historyKey(spaceId);
  const stored = await chrome.storage.local.get(key);
  const value = stored[key];
  return Array.isArray(value) ? (value as TaskHistoryEntry[]) : [];
}

export async function saveTaskHistoryEntry(
  entry: Omit<TaskHistoryEntry, "id" | "timestamp">,
  spaceId?: string
): Promise<void> {
  const preferences = await loadPreferences();
  if (!preferences.retainTaskHistory) return;

  // Resolved once, so the read and the write land in the same Space.
  const key = await historyKey(spaceId);
  const stored = (await chrome.storage.local.get(key))[key];
  const previous = Array.isArray(stored) ? (stored as TaskHistoryEntry[]) : [];
  const next: TaskHistoryEntry = {
    ...entry,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString()
  };
  await chrome.storage.local.set({
    [key]: [next, ...previous].slice(0, MAX_HISTORY)
  });
}

export async function clearTaskHistory(): Promise<void> {
  await chrome.storage.local.remove(await spaceKey(HISTORY_KEY));
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
