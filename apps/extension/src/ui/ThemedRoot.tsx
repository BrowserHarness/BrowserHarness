import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CssBaseline, ThemeProvider } from "@mui/material";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
import { createBrowserHarnessTheme, resolvePaletteMode } from "./theme";
import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  PREFERENCES_STORAGE_KEY,
  type UserPreferences
} from "../settings/preferences";

/** Every BrowserHarness page: follows the chosen light/dark look and text size, live. */
export function ThemedRoot({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<Pick<UserPreferences, "appearance" | "textSize">>(DEFAULT_PREFERENCES);
  const [prefersDark, setPrefersDark] = useState(window.matchMedia("(prefers-color-scheme: dark)").matches);

  useEffect(() => {
    void loadPreferences().then(setPreferences);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onMedia = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    media.addEventListener("change", onMedia);
    const onStorage = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      const next = changes[PREFERENCES_STORAGE_KEY]?.newValue as Partial<UserPreferences> | undefined;
      if (areaName === "local" && next) {
        setPreferences({
          appearance: next.appearance || DEFAULT_PREFERENCES.appearance,
          textSize: next.textSize || DEFAULT_PREFERENCES.textSize
        });
      }
    };
    chrome.storage.onChanged.addListener(onStorage);
    return () => {
      media.removeEventListener("change", onMedia);
      chrome.storage.onChanged.removeListener(onStorage);
    };
  }, []);

  const theme = useMemo(
    () => createBrowserHarnessTheme(resolvePaletteMode(preferences.appearance, prefersDark), preferences.textSize),
    [preferences.appearance, preferences.textSize, prefersDark]
  );

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {children}
    </ThemeProvider>
  );
}
