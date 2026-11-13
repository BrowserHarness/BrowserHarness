export type AppearanceMode = "system" | "light" | "dark";

/** How big the words are on every BrowserHarness screen. */
export type TextSize = "normal" | "large" | "larger";

/**
 * When the agent asks before acting:
 * - risky: only for send, submit, buy, delete and account changes (default)
 * - every: before every action that changes a page
 * - auto: never, except payments and account security
 * - guarded (level 4, for a dedicated agent computer): never, including
 *   learned API writes and agents connected through the Bridge. Payments,
 *   passwords and account security are still never answered for the person,
 *   so a page that tries to steer the agent cannot spend money or take over
 *   an account.
 * - full (level 5, for a dedicated agent computer): never, for anything,
 *   including payments, passwords and account security.
 */
export type ApprovalMode = "risky" | "every" | "auto" | "guarded" | "full";

export const APPROVAL_MODES: readonly ApprovalMode[] = ["risky", "every", "auto", "guarded", "full"];

/** Levels 4 and 5: also answer for agents connected through the Bridge. */
export function isAutopilotMode(mode: ApprovalMode): boolean {
  return mode === "guarded" || mode === "full";
}

export interface UserPreferences {
  appearance: AppearanceMode;
  retainTaskHistory: boolean;
  approvalMode: ApprovalMode;
  /** Pick up facts like "I live in Pune" from requests into About me. */
  learnAboutMe: boolean;
  /** Keep finished multi-step tasks as Skills, and use matching Skills as hints. */
  autoSkills: boolean;
  textSize: TextSize;
}

const KEY = "browserharness.preferences";

export const DEFAULT_PREFERENCES: UserPreferences = {
  appearance: "system",
  retainTaskHistory: true,
  approvalMode: "risky",
  learnAboutMe: true,
  autoSkills: true,
  textSize: "normal"
};

export async function loadPreferences(): Promise<UserPreferences> {
  const stored = await chrome.storage.local.get(KEY);
  const merged = {
    ...DEFAULT_PREFERENCES,
    ...(stored[KEY] as Partial<UserPreferences> | undefined)
  };
  // An unknown stored value never widens what runs without asking.
  if (!APPROVAL_MODES.includes(merged.approvalMode)) merged.approvalMode = DEFAULT_PREFERENCES.approvalMode;
  return merged;
}

export async function savePreferences(
  preferences: UserPreferences
): Promise<void> {
  await chrome.storage.local.set({ [KEY]: preferences });
}

export async function updatePreferences(
  patch: Partial<UserPreferences>
): Promise<UserPreferences> {
  const current = await loadPreferences();
  const next = { ...current, ...patch };
  await savePreferences(next);
  return next;
}

export const PREFERENCES_STORAGE_KEY = KEY;
