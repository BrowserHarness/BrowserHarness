import { useState, type ReactNode } from "react";
import { Box, Button, Divider, Stack, Typography } from "@mui/material";
import { Note, PageTitle, SettingsCard, useConfirm } from "../kit";
import { clearTaskHistory } from "../../runtime/history";
import { clearAboutMe } from "../../runtime/about-me";
import { saveInstructions } from "../../runtime/instructions";
import type { SectionProps } from "./SettingsShell";

function DeleteRow({ title, detail, button, onClick }: { title: string; detail: ReactNode; button: string; onClick: () => void }) {
  return (
    <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ xs: "flex-start", sm: "center" }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="subtitle1">{title}</Typography>
        <Typography variant="body2" color="text.secondary">
          {detail}
        </Typography>
      </Box>
      <Button color="error" variant="outlined" onClick={onClick} sx={{ flexShrink: 0 }}>
        {button}
      </Button>
    </Stack>
  );
}

export function PrivacyPage(_props: SectionProps) {
  const [dialog, confirm] = useConfirm();
  const [done, setDone] = useState("");

  const run = async (request: Parameters<typeof confirm>[0], action: () => Promise<void>, message: string) => {
    if (!(await confirm({ ...request, danger: true }))) return;
    await action();
    setDone(message);
  };

  return (
    <>
      {dialog}
      <PageTitle title="Privacy & your data" intro="What BrowserHarness keeps, where it goes, and how to delete it." />
      <Stack spacing={2.5}>
        <SettingsCard title="Where your information goes">
          <Stack spacing={1.25}>
            <Typography variant="body2">
              <strong>Kept on this computer only:</strong> your task history, facts about you, your wishes, Skills,
              scheduled tasks and settings. The keys that connect your AI stay inside this Chrome.
            </Typography>
            <Typography variant="body2">
              <strong>Sent to the AI you connected:</strong> your request and the parts of web pages it needs to read, so
              the AI can decide what to do. The AI company's own privacy rules apply to that. A model on your own computer
              (LM Studio or Ollama) keeps even this on your computer.
            </Typography>
            <Typography variant="body2">
              <strong>Sent to chat apps, if you set them up:</strong> the replies and results you asked to receive there.
            </Typography>
            <Typography variant="body2">
              <strong>Never sent to BrowserHarness:</strong> there is no BrowserHarness account and no tracking.
            </Typography>
          </Stack>
        </SettingsCard>

        <SettingsCard title="Delete things">
          {done && <Note kind="success">{done}</Note>}
          <DeleteRow
            title="Task history"
            detail="Everything you asked and every answer. Your Skills and settings stay."
            button="Delete history"
            onClick={() =>
              void run(
                { title: "Delete your task history?", body: "All past tasks and answers are deleted. This can't be undone.", confirmLabel: "Delete history" },
                clearTaskHistory,
                "Your task history was deleted."
              )
            }
          />
          <Divider />
          <DeleteRow
            title="What it knows about you"
            detail="Every fact under About you, and your wishes for how it should work."
            button="Forget about me"
            onClick={() =>
              void run(
                {
                  title: "Forget everything about you?",
                  body: "All saved facts and your wishes are deleted. This can't be undone.",
                  confirmLabel: "Forget everything"
                },
                async () => {
                  await clearAboutMe();
                  await saveInstructions("");
                },
                "BrowserHarness forgot everything about you."
              )
            }
          />
          <Divider />
          <DeleteRow
            title="Start completely fresh"
            detail="Deletes everything: your AI connection, history, facts, Skills, schedules and settings. Like a new install."
            button="Delete everything"
            onClick={() =>
              void run(
                {
                  title: "Delete everything?",
                  body: (
                    <>
                      BrowserHarness will forget <strong>everything</strong>, including how to reach your AI. You will need
                      to connect your AI again. This can't be undone.
                    </>
                  ),
                  confirmLabel: "Delete everything"
                },
                async () => {
                  await chrome.storage.local.clear();
                  await chrome.storage.session.clear();
                },
                "Everything was deleted. Connect your AI again under “Your AI” to start."
              )
            }
          />
        </SettingsCard>
      </Stack>
    </>
  );
}
