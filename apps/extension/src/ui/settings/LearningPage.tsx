import { useEffect, useState } from "react";
import { Button, Divider, Stack } from "@mui/material";
import { PageTitle, SettingsCard, ToggleSetting, useConfirm } from "../kit";
import { DEFAULT_PREFERENCES, loadPreferences, updatePreferences, type UserPreferences } from "../../settings/preferences";
import { clearTaskHistory } from "../../runtime/history";
import type { SectionProps } from "./SettingsShell";
import { useSaved } from "../feedback";

export function LearningPage({ go }: SectionProps) {
  const [preferences, setPreferences] = useState<UserPreferences>(DEFAULT_PREFERENCES);
  const [dialog, confirm] = useConfirm();

  useEffect(() => {
    void loadPreferences().then(setPreferences);
  }, []);

  const saved = useSaved();
  const set = async (patch: Partial<UserPreferences>) => {
    setPreferences(await updatePreferences(patch));
    saved(Object.values(patch)[0] ? "Saved. Turned on" : "Saved. Turned off");
  };

  const setHistory = async (keep: boolean) => {
    if (!keep) {
      const ok = await confirm({
        title: "Turn off task history?",
        body: "Your past tasks will be deleted now, and new ones won't be kept. BrowserHarness also won't be able to remember your past conversations. This can't be undone.",
        confirmLabel: "Turn off and delete",
        danger: true
      });
      if (!ok) return;
      await clearTaskHistory();
    }
    await set({ retainTaskHistory: keep });
  };

  return (
    <>
      {dialog}
      <PageTitle
        title="Learning & memory"
        intro="BrowserHarness can get better the more you use it: it remembers facts about you, keeps your past tasks, and learns tasks it can repeat. Everything stays on this computer."
      />
      <SettingsCard>
        <ToggleSetting
          label="Remember facts you mention"
          help="When you say things like “I live in Pune” or “I prefer aisle seats”, BrowserHarness saves them under About you."
          whenOn="It notices facts in your requests and keeps them, so later tasks already know them. When something changes, the new fact replaces the old one."
          whenOff="It only remembers facts you add yourself under About you."
          recommended="Keep this on. It never saves passwords, card numbers or ID numbers, and you can delete any fact."
          checked={preferences.learnAboutMe}
          onChange={(value) => void set({ learnAboutMe: value })}
        />
        <Stack direction="row">
          <Button size="small" onClick={() => go("about")}>
            See what it knows about you
          </Button>
        </Stack>
        <Divider />
        <ToggleSetting
          label="Learn Skills on its own"
          help="When a task takes several steps and works, BrowserHarness can keep it as a Skill and do it faster next time."
          whenOn="Finished tasks with several steps are saved as Skills marked “Learned on its own”. When you ask for something similar, it follows the saved steps."
          whenOff="It only keeps the Skills you save yourself with the “Save as Skill” button."
          recommended="Keep this on. You can delete any Skill it learns, or press “Keep” to make it permanent."
          checked={preferences.autoSkills}
          onChange={(value) => void set({ autoSkills: value })}
        />
        <Stack direction="row">
          <Button size="small" onClick={() => go("skills")}>
            See saved Skills
          </Button>
        </Stack>
        <Divider />
        <ToggleSetting
          label="Keep a history of your tasks"
          help="A list of what you asked and what BrowserHarness answered, kept on this computer (the last 500)."
          whenOn="You can search past tasks, run them again, and ask things like “what did I find last week about kettles?”."
          whenOff="Nothing is kept after a task finishes, and the history you have now is deleted."
          recommended="Keep this on, unless other people use this computer and shouldn't see your tasks."
          checked={preferences.retainTaskHistory}
          onChange={(value) => void setHistory(value)}
        />
        <Stack direction="row">
          <Button size="small" onClick={() => go("history")}>
            See task history
          </Button>
        </Stack>
      </SettingsCard>
    </>
  );
}
