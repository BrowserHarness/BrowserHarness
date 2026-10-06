// From the big Settings tab, "Run" or "Use" sends the request to the chat in
// the side panel: the request waits in session storage, the side panel opens,
// and the chat picks it up.
export const PENDING_PROMPT_KEY = "browserharness.pendingPrompt";

export interface PendingPrompt {
  text: string;
  /** Start it straight away, or only put it in the chat box. */
  run: boolean;
  at: number;
}

let windowId: number | undefined;
// Learned early, because opening the side panel must happen right on the click.
void chrome.windows?.getCurrent?.().then((window) => (windowId = window.id)).catch(() => undefined);

export function handToSidePanel(text: string, run: boolean): void {
  if (windowId !== undefined) void chrome.sidePanel?.open?.({ windowId }).catch(() => undefined);
  void chrome.storage.session.set({ [PENDING_PROMPT_KEY]: { text, run, at: Date.now() } satisfies PendingPrompt });
}

/** The chat takes a waiting request once, if it is fresh. */
export async function takePendingPrompt(maxAgeMs = 60_000): Promise<PendingPrompt | null> {
  const pending = (await chrome.storage.session.get(PENDING_PROMPT_KEY))[PENDING_PROMPT_KEY] as PendingPrompt | undefined;
  if (!pending) return null;
  await chrome.storage.session.remove(PENDING_PROMPT_KEY);
  return Date.now() - pending.at <= maxAgeMs ? pending : null;
}
