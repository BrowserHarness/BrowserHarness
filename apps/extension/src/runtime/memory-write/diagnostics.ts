// The last few memory writes, for developers: what was offered, from where,
// what it was taken for and what happened. Only kinds, levels, scores and
// reasons are kept, never the words themselves. Session storage, so it
// clears when the browser closes.
import type { WriteDiagnostics } from "./types";

export const WRITE_DIAGNOSTICS_KEY = "browserharness.memoryWriteDiagnostics";
const MAX_RECORDS = 30;

function area(): chrome.storage.StorageArea | null {
  try {
    return globalThis.chrome?.storage?.session ?? null;
  } catch {
    return null;
  }
}

export async function recordWriteDiagnostics(record: WriteDiagnostics): Promise<void> {
  const storage = area();
  if (!storage) return;
  try {
    const previous = (await storage.get(WRITE_DIAGNOSTICS_KEY))[WRITE_DIAGNOSTICS_KEY];
    const list = Array.isArray(previous) ? (previous as WriteDiagnostics[]) : [];
    await storage.set({ [WRITE_DIAGNOSTICS_KEY]: [record, ...list].slice(0, MAX_RECORDS) });
  } catch {
    // Diagnostics never get in the way of remembering.
  }
}

export async function loadWriteDiagnostics(): Promise<WriteDiagnostics[]> {
  const storage = area();
  if (!storage) return [];
  const value = (await storage.get(WRITE_DIAGNOSTICS_KEY))[WRITE_DIAGNOSTICS_KEY];
  return Array.isArray(value) ? (value as WriteDiagnostics[]) : [];
}
