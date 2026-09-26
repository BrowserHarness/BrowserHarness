export type AppearanceMode = "system" | "light" | "dark";

export interface UserPreferences {
  appearance: AppearanceMode;
  retainTaskHistory: boolean;
}

const KEY = "browsercrew.preferences";

export const DEFAULT_PREFERENCES: UserPreferences = {
  appearance: "system",
  retainTaskHistory: true
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
