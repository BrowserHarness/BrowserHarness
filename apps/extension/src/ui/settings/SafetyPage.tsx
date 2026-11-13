import { useEffect, useState } from "react";
import { Box, Button, Paper, Stack, Typography } from "@mui/material";
import { ChoiceCards, Note, Outcomes, PageTitle, SettingsCard, useConfirm, type Choice } from "../kit";
import { DEFAULT_PREFERENCES, loadPreferences, updatePreferences, type ApprovalMode } from "../../settings/preferences";
import { loadSiteGrants, removeGrant, saveSiteGrants, SITE_GRANTS_KEY, type SiteGrant } from "../../settings/site-grants";
import type { SectionProps } from "./SettingsShell";
import { useSaved } from "../feedback";

export const APPROVAL_CHOICES: Choice<ApprovalMode>[] = [
  {
    value: "risky",
    title: "Ask me only before important steps",
    recommended: true,
    description:
      "It reads, searches and clicks around on its own, and stops to ask you before it sends a message, submits a form, buys something or deletes anything."
  },
  {
    value: "every",
    title: "Ask me before every step",
    description:
      "It asks before every click and everything it types. The safest choice, but you will press Approve many times. Good while you get to know BrowserHarness."
  },
  {
    value: "auto",
    title: "Don't ask me, except for money and passwords",
    description:
      "It sends, submits and deletes without stopping. It still always asks before paying, ordering, or changing a password or account security.",
    warning: (
      <>
        Only choose this if you trust every task you give it. A mistake, like a message sent to the wrong person or a
        deleted email, can't be taken back. Most people should keep “Ask me only before important steps”.
      </>
    )
  },
  {
    value: "guarded",
    title: "Autopilot, protected (for an agent's own computer)",
    description:
      "It never stops to ask, for anything it does, including for AI agents connected through the Bridge. To protect you from websites that try to trick it, it will still never pay, order, type a password, card number or code, or change account security on its own: those stop the task instead.",
    warning: (
      <>
        Only for a computer and Chrome profile set aside for the agent, not your own. Messages it sends and data it
        deletes can't be taken back.
      </>
    )
  },
  {
    value: "full",
    title: "Full control, including payments (for an agent's own computer)",
    description:
      "It never stops to ask, for anything. It can pay, place orders, use saved cards, type passwords and change account settings on its own.",
    warning: (
      <>
        Nothing protects you from a mistake or from a website that tricks it. Use only on a computer set aside for the
        agent, signed in only to accounts it should use, with a prepaid or virtual card that has a low spending limit.
      </>
    )
  }
];

const AUTOPILOT_CONFIRM: Partial<Record<ApprovalMode, { title: string; body: string; confirmLabel: string }>> = {
  guarded: {
    title: "Turn on protected autopilot?",
    body: "BrowserHarness will send, submit and delete without asking you, including for agents connected through the Bridge. It still won't pay, order or handle passwords and codes on its own. Only use this on a computer set aside for the agent.",
    confirmLabel: "Yes, turn it on"
  },
  full: {
    title: "Give it full control, including payments?",
    body: "BrowserHarness will do anything a task needs without asking: pay with saved cards, place orders, type passwords and change account security. A mistake or a tricky website can cost real money. Only use this on a computer set aside for the agent, with a card that has a low limit.",
    confirmLabel: "Yes, give full control"
  }
};

export function SafetyPage(_props: SectionProps) {
  const [mode, setMode] = useState<ApprovalMode>(DEFAULT_PREFERENCES.approvalMode);
  const [grants, setGrants] = useState<SiteGrant[]>([]);
  const [dialog, confirm] = useConfirm();
  const saved = useSaved();

  useEffect(() => {
    void loadPreferences().then((preferences) => setMode(preferences.approvalMode));
    const refresh = () => void loadSiteGrants().then(setGrants).catch(() => undefined);
    refresh();
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && changes[SITE_GRANTS_KEY]) refresh();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  const choose = async (next: ApprovalMode) => {
    const warning = AUTOPILOT_CONFIRM[next];
    if (warning && next !== mode) {
      const ok = await confirm({ ...warning, danger: true });
      if (!ok) return;
    }
    setMode(next);
    await updatePreferences({ approvalMode: next });
    saved(`Saved. ${APPROVAL_CHOICES.find((choice) => choice.value === next)?.title}`);
  };

  const stopAllowing = async (host: string) => {
    const ok = await confirm({
      title: `Ask again on ${host}?`,
      body: `From now on, BrowserHarness will stop and ask you before important steps on ${host}, like everywhere else.`,
      confirmLabel: "Yes, ask me again"
    });
    if (!ok) return;
    const next = removeGrant(grants, host);
    await saveSiteGrants(next);
    setGrants(next);
    saved(`Saved. It asks you again on ${host}`);
  };

  return (
    <>
      {dialog}
      <PageTitle
        title="Safety & approvals"
        intro="BrowserHarness can click and type on websites for you. Here you decide when it must stop and ask for your OK first."
      />
      <Stack spacing={2.5}>
        <SettingsCard>
          <ChoiceCards
            label="When should it ask you before acting?"
            help="When it asks, a card appears in the chat with Approve and Cancel. Nothing happens until you press one."
            choices={APPROVAL_CHOICES}
            value={mode}
            onChange={(value) => void choose(value)}
          />
        </SettingsCard>

        <SettingsCard
          title="Websites where it never asks"
          intro={
            <>
              When an approval card appears, you can press <strong>Always allow on this site</strong>. Those websites are
              listed here.
            </>
          }
        >
          <Outcomes
            whenOn="On these websites BrowserHarness goes ahead without asking, even before paying or deleting."
            whenOff="Remove a website and it asks you again there, like everywhere else."
            recommended="Only allow websites where you are happy for it to act on its own, like a news site or your own notes. Never your bank."
          />
          {grants.length === 0 ? (
            <Note kind="success">No websites are allowed yet, so it asks you everywhere.</Note>
          ) : (
            <Stack spacing={1}>
              {grants.map((grant) => (
                <Paper key={grant.host} variant="outlined" sx={{ p: 1.25, pl: 2 }}>
                  <Stack direction="row" alignItems="center" spacing={1}>
                    <Typography variant="body1" sx={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                      {grant.host}
                    </Typography>
                    <Button size="small" color="error" variant="outlined" onClick={() => void stopAllowing(grant.host)} aria-label={`Stop allowing ${grant.host}`}>
                      Ask again here
                    </Button>
                  </Stack>
                </Paper>
              ))}
            </Stack>
          )}
        </SettingsCard>

        <SettingsCard title="What BrowserHarness can reach">
          <Typography variant="body2">
            To do tasks for you, BrowserHarness can open and read any website in this Chrome, work across tabs and
            windows, fill in forms, upload files you give it, and save pages as PDF. It only does this when you ask it
            to, or when a task you scheduled runs.
          </Typography>
          <Box>
            <Note kind="tip" title="Good to know">
              Unless you chose “Full control, including payments”, it asks you before paying for something or changing
              a password or account security, except on websites you allowed.
            </Note>
          </Box>
        </SettingsCard>
      </Stack>
    </>
  );
}
