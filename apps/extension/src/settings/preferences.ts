export type AppearanceMode = "system" | "light" | "dark";

/**
 * When the agent asks before acting:
 * - risky: only for send, submit, buy, delete and account changes (default)
 * - every: before every action that changes a page
 * - auto: never, except payments and account security
 */
export type ApprovalMode = "risky" | "every" | "auto";

export interface UserPreferences {
  appearance: AppearanceMode;
  retainTaskHistory: boolean;
  approvalMode: ApprovalMode;
  /** Pick up facts like "I live in Pune" from requests into About me. */
  learnAboutMe: boolean;
  /** Keep finished multi-step tasks as Skills, and use matching Skills as hints. */
  autoSkills: boolean;
}

const KEY = "browserharness.preferences";

export const DEFAULT_PREFERENCES: UserPreferences = {
  appearance: "system",
  retainTaskHistory: true,
  approvalMode: "risky",
  learnAboutMe: true,
  autoSkills: true
};

export async function loadPreferences(): Promise<UserPreferences> {
  const stored = await chrome.storage.local.get(KEY);
  return {
    ...DEFAULT_PREFERENCES,
    ...(stored[KEY] as Partial<UserPreferences> | undefined)
  };
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
