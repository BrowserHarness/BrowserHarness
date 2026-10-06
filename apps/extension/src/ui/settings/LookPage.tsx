import { useEffect, useState } from "react";
import { Stack } from "@mui/material";
import { ChoiceCards, Note, PageTitle, SettingsCard } from "../kit";
import { DEFAULT_PREFERENCES, loadPreferences, updatePreferences, type AppearanceMode, type TextSize, type UserPreferences } from "../../settings/preferences";
import type { SectionProps } from "./SettingsShell";
import { useSaved } from "../feedback";

export function LookPage(_props: SectionProps) {
  const [preferences, setPreferences] = useState<UserPreferences>(DEFAULT_PREFERENCES);
  useEffect(() => {
    void loadPreferences().then(setPreferences);
  }, []);
  const saved = useSaved();
  const set = async (patch: Partial<UserPreferences>, note: string) => {
    setPreferences(await updatePreferences(patch));
    saved(note);
  };

  return (
    <>
      <PageTitle title="Look & text size" intro="Make BrowserHarness comfortable to read. Changes show right away, everywhere." />
      <Stack spacing={2.5}>
        <SettingsCard>
          <ChoiceCards<TextSize>
            label="Text size"
            help="How big the words are in the chat and in Settings."
            columns={3}
            value={preferences.textSize}
            onChange={(value) => void set({ textSize: value }, "Saved. Text size changed")}
            choices={[
              { value: "normal", title: "Normal", recommended: true, description: "Fits the most on the screen." },
              { value: "large", title: "Large", description: "A little bigger. Easier on the eyes." },
              { value: "larger", title: "Extra large", description: "Much bigger. Best if small text is hard to read." }
            ]}
          />
          <Note kind="tip">
            This changes BrowserHarness only. To make websites bigger too, hold Ctrl (Cmd on a Mac) and press the + key.
          </Note>
        </SettingsCard>
        <SettingsCard>
          <ChoiceCards<AppearanceMode>
            label="Light or dark"
            help="Dark is easier on the eyes at night. Light is easier to read in a bright room."
            columns={3}
            value={preferences.appearance}
            onChange={(value) => void set({ appearance: value }, value === "dark" ? "Saved. Always dark" : value === "light" ? "Saved. Always light" : "Saved. Same as your computer")}
            choices={[
              {
                value: "system",
                title: "Same as my computer",
                recommended: true,
                description: "Follows your computer's setting, and switches when it does."
              },
              { value: "light", title: "Always light", description: "Dark text on a white background." },
              { value: "dark", title: "Always dark", description: "Light text on a dark background." }
            ]}
          />
        </SettingsCard>
      </Stack>
    </>
  );
}
