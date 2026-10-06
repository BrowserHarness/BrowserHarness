import type { ReactNode } from "react";
import { Box, Button, Divider, Stack, Typography } from "@mui/material";
import { PageTitle, SettingsCard, StatusPill, Steps } from "../kit";
import { CHAT_APP_LABELS, isChatApp } from "../../runtime/schedules";
import { APPROVAL_CHOICES } from "./SafetyPage";
import type { SectionProps } from "./SettingsShell";
import { useSetupStatus } from "./useSetupStatus";

function SetupRow({
  title,
  status,
  detail,
  button,
  onClick,
  optional,
  primary
}: {
  title: string;
  status: ReactNode;
  detail: ReactNode;
  button: string;
  onClick: () => void;
  optional?: boolean;
  /** The one thing to do next. */
  primary?: boolean;
}) {
  return (
    <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ xs: "flex-start", sm: "center" }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography variant="subtitle1">{title}</Typography>
          {optional && (
            <Typography variant="caption" color="text.secondary">
              (you can skip this)
            </Typography>
          )}
        </Stack>
        <Box mt={0.25}>{status}</Box>
        <Typography variant="body2" color="text.secondary" mt={0.5}>
          {detail}
        </Typography>
      </Box>
      <Button variant={primary ? "contained" : "outlined"} onClick={onClick} sx={{ flexShrink: 0 }}>
        {button}
      </Button>
    </Stack>
  );
}

const EXAMPLES = [
  "Find the cheapest flight from Delhi to Goa next Friday",
  "Read this page and tell me the main points in 5 lines",
  "Search Amazon for an electric kettle under ₹2,000 and list the three best"
];

export function HomePage({ go, actions }: SectionProps) {
  const status = useSetupStatus();
  const approval = APPROVAL_CHOICES.find((choice) => choice.value === status.preferences.approvalMode);
  const apps = status.chatApps.filter(isChatApp).map((app) => CHAT_APP_LABELS[app]);

  return (
    <>
      <PageTitle
        title="Welcome to BrowserHarness"
        intro={
          <>
            BrowserHarness is a helper that lives in Chrome. You tell it what you want in plain words, like “find the
            cheapest flight to Goa next Friday”, and it reads web pages, clicks and types for you. Before anything
            important, like paying or sending, it asks you first.
          </>
        }
      />
      <Stack spacing={2.5}>
        <SettingsCard title="Your setup" intro="Each part below shows if it is ready. The first one is the only one you must do.">
          <SetupRow
            title="1. Connect an AI"
            status={
              status.ai ? (
                <StatusPill state={status.ai.canUseBrowser ? "good" : "waiting"}>
                  {status.ai.canUseBrowser ? `Ready: ${status.ai.name}` : `${status.ai.name} can chat, but can't use the browser`}
                </StatusPill>
              ) : (
                <StatusPill state={status.loaded ? "problem" : "off"}>{status.loaded ? "Not connected yet" : "Checking…"}</StatusPill>
              )
            }
            detail="The AI is the “brain” that understands your request and decides what to click. BrowserHarness needs one to work."
            button={status.ai ? "Change" : "Connect an AI"}
            primary={status.loaded && !status.ai}
            onClick={() => go("ai")}
          />
          <Divider />
          <SetupRow
            title="2. Choose how careful it should be"
            status={<StatusPill state="good">{approval?.title || "Ask me only before important steps"}</StatusPill>}
            detail="Decide when BrowserHarness must stop and ask you before it acts. The normal choice suits most people."
            button="Review"
            onClick={() => go("safety")}
          />
          <Divider />
          <SetupRow
            optional
            title="3. Tell it about you"
            status={
              <StatusPill state={status.facts || status.hasInstructions ? "good" : "off"}>
                {status.facts || status.hasInstructions
                  ? `${status.facts} fact${status.facts === 1 ? "" : "s"}${status.hasInstructions ? " and your wishes" : ""} saved`
                  : "Nothing saved yet"}
              </StatusPill>
            }
            detail="Things like your city or “always show prices in rupees”, so you don't have to repeat them."
            button={status.facts || status.hasInstructions ? "See" : "Add"}
            onClick={() => go("about")}
          />
          <Divider />
          <SetupRow
            optional
            title="4. Use it from your phone"
            status={
              apps.length ? (
                <StatusPill state="good">On in {apps.join(", ")}</StatusPill>
              ) : status.helper === "connected" ? (
                <StatusPill state="waiting">Helper app connected, no chat app yet</StatusPill>
              ) : (
                <StatusPill state="off">Not set up</StatusPill>
              )
            }
            detail="Send tasks from Telegram, Discord, Slack or email while you are away. Needs the free helper app on this computer."
            button={apps.length ? "Manage" : "Set up"}
            onClick={() => go("phone")}
          />
        </SettingsCard>

        <SettingsCard title="Try your first task">
          <Steps
            steps={[
              <>
                Click the BrowserHarness icon at the top right of Chrome. If you can't see it, click the puzzle piece
                first, then the pin next to BrowserHarness so it stays there.
              </>,
              <>Type what you want in the box at the bottom, the way you would ask a person, and press Enter.</>,
              <>Watch it work. When it needs your OK, a card appears with Approve and Cancel buttons.</>
            ]}
          />
          <Box>
            <Typography variant="body2" color="text.secondary" mb={1}>
              Or press one of these to put it in the chat box for you:
            </Typography>
            <Stack spacing={1} alignItems="flex-start">
              {EXAMPLES.map((example) => (
                <Button key={example} variant="text" onClick={() => actions.fillPrompt(example)} sx={{ textAlign: "left", px: 1 }}>
                  “{example}”
                </Button>
              ))}
            </Stack>
          </Box>
        </SettingsCard>
      </Stack>
    </>
  );
}
