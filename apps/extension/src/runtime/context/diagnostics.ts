// The last few compiled contexts, for developers: what was considered, what
// went and why. Only references, reasons and sizes are kept, never the text
// of facts, chats or pages. Kept in session storage, so it clears when the
// browser closes.
import type { ContextDiagnostics } from "./types";

export const CONTEXT_DIAGNOSTICS_KEY = "browserharness.contextDiagnostics";
const MAX_RECORDS = 20;

function area(): chrome.storage.StorageArea | null {
  try {
    return globalThis.chrome?.storage?.session ?? null;
  } catch {
    return null;
  }
}

export async function recordContextDiagnostics(diagnostics: ContextDiagnostics): Promise<void> {
  const storage = area();
  if (!storage) return;
  try {
    const previous = (await storage.get(CONTEXT_DIAGNOSTICS_KEY))[CONTEXT_DIAGNOSTICS_KEY];
    const list = Array.isArray(previous) ? (previous as ContextDiagnostics[]) : [];
    await storage.set({ [CONTEXT_DIAGNOSTICS_KEY]: [diagnostics, ...list].slice(0, MAX_RECORDS) });
  } catch {
    // Diagnostics never get in the way of a task.
  }
}

export async function loadContextDiagnostics(): Promise<ContextDiagnostics[]> {
  const storage = area();
  if (!storage) return [];
  const value = (await storage.get(CONTEXT_DIAGNOSTICS_KEY))[CONTEXT_DIAGNOSTICS_KEY];
  return Array.isArray(value) ? (value as ContextDiagnostics[]) : [];
}
