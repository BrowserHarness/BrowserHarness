import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import { CssBaseline, ThemeProvider } from "@mui/material";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
import { App } from "./ui/App";
import {
  createBrowserHarnessTheme,
  resolvePaletteMode
} from "./ui/theme";
import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  PREFERENCES_STORAGE_KEY,
  type AppearanceMode
} from "./settings/preferences";

function Root() {
  const [appearance, setAppearance] = useState<AppearanceMode>(
    DEFAULT_PREFERENCES.appearance
  );
  const [prefersDark, setPrefersDark] = useState(
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );

  useEffect(() => {
    void loadPreferences().then((preferences) =>
      setAppearance(preferences.appearance)
    );

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onMedia = (event: MediaQueryListEvent) =>
      setPrefersDark(event.matches);
    media.addEventListener("change", onMedia);

    const onStorage = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ) => {
      if (
        areaName === "local" &&
        changes[PREFERENCES_STORAGE_KEY]?.newValue
      ) {
        setAppearance(
          changes[PREFERENCES_STORAGE_KEY].newValue.appearance ||
            DEFAULT_PREFERENCES.appearance
        );
      }
    };
    chrome.storage.onChanged.addListener(onStorage);

    return () => {
      media.removeEventListener("change", onMedia);
      chrome.storage.onChanged.removeListener(onStorage);
    };
  }, []);

  const theme = useMemo(
    () =>
      createBrowserHarnessTheme(
        resolvePaletteMode(appearance, prefersDark)
      ),
    [appearance, prefersDark]
  );

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
