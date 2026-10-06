import { useState, type ReactNode } from "react";
import { Box, Button, Paper, Stack, Typography } from "@mui/material";
import { ChoiceCards, CopyBox, MoreDetails, Note, PageTitle, SettingsCard, StatusPill, Steps, type Choice } from "../kit";
import { CHAT_APP_LABELS, type ChatApp } from "../../runtime/schedules";
import { HelperStatus, useHelperApp } from "./HelperAppPage";
import type { SectionProps } from "./SettingsShell";

const APP_CHOICES: Choice<ChatApp>[] = [
  { value: "telegram", title: "Telegram", recommended: true, description: "The easiest. About 2 minutes, all from your phone and one command." },
  { value: "discord", title: "Discord", description: "If you already use Discord. You make a bot on Discord's website." },
  { value: "slack", title: "Slack", description: "For work Slack. Takes about 10 minutes on Slack's website." },
  { value: "signal", title: "Signal", description: "Needs a spare phone number for the bot and an extra program." },
  { value: "email", title: "Email", description: "Email tasks to a separate mailbox made just for the bot." },
  { value: "mattermost", title: "Mattermost", description: "If your team uses Mattermost." },
  { value: "matrix", title: "Matrix", description: "For Element and other Matrix apps." }
];

const ALLOW_HINT: Record<ChatApp, string> = {
  telegram: "987654321",
  discord: "123456789012345678",
  slack: "U0123ABCD",
  signal: "+15551234567",
  mattermost: "abc123…",
  matrix: "@you:matrix.org",
  email: "you@example.com"
};

function SetupSteps({ app }: { app: ChatApp }): ReactNode {
  const allow = (
    <>
      Send your bot any message. Because it doesn't know you yet, it replies with a command like{" "}
      <code>
        browserharness-bridge {app} allow {ALLOW_HINT[app]}
      </code>
      . Type that command on this computer. Now only you can use your bot.
    </>
  );
  const run = (command: string) => (
    <>
      On this computer, open a terminal and type this, with your own details in place of the &lt;…&gt; parts:
      <CopyBox text={command} />
    </>
  );
  switch (app) {
    case "telegram":
      return (
        <Steps
          steps={[
            <>
              In Telegram, search for <strong>@BotFather</strong> (it has a blue tick), open it and send{" "}
              <code>/newbot</code>.
            </>,
            <>Choose a name and a username for your bot. BotFather replies with a long code called a token. Copy it.</>,
            run("browserharness-bridge telegram setup --token <the token from BotFather>"),
            allow
          ]}
        />
      );
    case "discord":
      return (
        <Steps
          steps={[
            <>
              Open the Discord Developer Portal (discord.com/developers/applications), choose <strong>New
              Application</strong> and give it a name.
            </>,
            <>
              Open <strong>Bot</strong>, press <strong>Reset Token</strong> and copy the token.
            </>,
            run("browserharness-bridge discord setup --token <the bot token>"),
            <>It answers with an invite link. Open it and add the bot to a Discord server you own.</>,
            allow
          ]}
        />
      );
    case "slack":
      return (
        <Stack spacing={1.5}>
          <Steps
            steps={[
              <>
                Open api.slack.com/apps and choose <strong>Create New App</strong>, then <strong>From scratch</strong>.
              </>,
              <>
                Turn on <strong>Socket Mode</strong> and make an app token with <code>connections:write</code>. Copy it
                (it starts with <code>xapp-</code>).
              </>,
              <>
                Under <strong>OAuth &amp; Permissions</strong>, add <code>chat:write</code>, <code>im:history</code>,{" "}
                <code>app_mentions:read</code> and <code>files:read</code>.
              </>,
              <>
                Under <strong>Event Subscriptions</strong>, turn them on and add <code>message.im</code> and{" "}
                <code>app_mention</code>. Under <strong>App Home</strong>, turn on the Messages tab.
              </>,
              <>
                Press <strong>Install to Workspace</strong> and copy the Bot User OAuth Token (it starts with{" "}
                <code>xoxb-</code>).
              </>,
              run("browserharness-bridge slack setup --bot-token <xoxb-…> --app-token <xapp-…>"),
              allow
            ]}
          />
        </Stack>
      );
    case "signal":
      return (
        <Steps
          steps={[
            <>Get a spare phone number for the bot. Your own number can't be the bot.</>,
            <>Install signal-cli (github.com/AsamK/signal-cli) and register the spare number with it, following its guide.</>,
            run("browserharness-bridge signal setup --number <the bot's number, like +15551234567>"),
            <>From your own phone, send a Signal message to the bot's number. {allow}</>
          ]}
        />
      );
    case "email":
      return (
        <Steps
          steps={[
            <>
              Make a new mailbox just for the bot (for example a new Gmail account). Don't use your own: the bot marks
              mail as read and replies from it.
            </>,
            <>
              In that mailbox, turn on two-step sign-in and make an <strong>app password</strong> (Gmail: Google
              Account, Security, App passwords).
            </>,
            run("browserharness-bridge email setup --address <the bot's address> --password <the app password>"),
            <>
              Allow your own address:
              <CopyBox text="browserharness-bridge email allow <your own email address>" />
            </>,
            <>Email the bot a task. It only acts on mail your provider confirms really came from you.</>
          ]}
        />
      );
    case "mattermost":
      return (
        <Steps
          steps={[
            <>
              In Mattermost, open <strong>Integrations</strong>, <strong>Bot Accounts</strong>, <strong>Add Bot
              Account</strong>, and copy its access token.
            </>,
            run("browserharness-bridge mattermost setup --server <https://your.mattermost.address> --token <the bot's token>"),
            allow
          ]}
        />
      );
    case "matrix":
      return (
        <Steps
          steps={[
            <>
              Make a separate Matrix account for the bot and copy its access token (in Element: Settings, Help &amp;
              About, Access Token).
            </>,
            run("browserharness-bridge matrix setup --homeserver <https://matrix.org> --token <the bot's token>"),
            <>
              Allow your own Matrix account:
              <CopyBox text="browserharness-bridge matrix allow <@you:matrix.org>" />
            </>,
            <>Start a room with the bot with encryption turned off, and invite it.</>
          ]}
        />
      );
  }
}

const COMMANDS: [string, string][] = [
  ["/status", "What's running now, and your next scheduled tasks"],
  ["/stop", "Stop the tasks you started from this app"],
  ["/schedule every weekday at 8am check my inbox", "Run a task by itself on a schedule, and send you the result"],
  ["/schedules", "Your scheduled tasks, numbered"],
  ["/unschedule 2", "Turn off the second one"],
  ["/help", "What the bot can do"]
];

export function PhonePage({ go }: SectionProps) {
  const helper = useHelperApp();
  const [app, setApp] = useState<ChatApp>("telegram");
  const running = new Set((helper.connected ? helper.status?.chat_apps || [] : []).filter((name) => name in CHAT_APP_LABELS));

  return (
    <>
      <PageTitle
        title="Phone & chat apps"
        intro="Message your own private bot from your phone, like “check my inbox for invoices”. BrowserHarness does the task in Chrome on this computer and replies with the result."
      />
      <Stack spacing={2.5}>
        <SettingsCard title="What you need">
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ xs: "flex-start", sm: "center" }}>
            <Box sx={{ flex: 1 }}>
              <Typography variant="subtitle1">The helper app on this computer</Typography>
              <HelperStatus helper={helper} />
            </Box>
            {!helper.connected && (
              <Button variant="contained" onClick={() => go("helper")}>
                Set up the helper app
              </Button>
            )}
          </Stack>
          <Typography variant="body2" color="text.secondary">
            This computer must be on, with Chrome open, when you send a task. Your AI must be connected under Your AI.
          </Typography>
          <Note kind="tip" title="Your bot is private">
            Only the accounts you allow can use it. Everyone else is told “this bot is private”. Anything that needs your
            OK, like paying, sending or deleting, waits for you at the computer.
          </Note>
        </SettingsCard>

        <SettingsCard title="Your chat apps" intro={helper.connected ? "Apps with a bot that is set up and running." : "Connect the helper app to see which apps are on."}>
          <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: { xs: "1fr 1fr", sm: "repeat(4, 1fr)" } }}>
            {APP_CHOICES.map((choice) => (
              <Paper key={choice.value} variant="outlined" sx={{ p: 1.25 }}>
                <Typography variant="body2" fontWeight={600}>
                  {choice.title}
                </Typography>
                <StatusPill state={running.has(choice.value) ? "good" : "off"}>{running.has(choice.value) ? "On" : "Not set up"}</StatusPill>
              </Paper>
            ))}
          </Box>
        </SettingsCard>

        <SettingsCard title="Add a chat app">
          <ChoiceCards label="Which app do you want to use?" choices={APP_CHOICES} value={app} onChange={setApp} columns={2} />
          <Box>
            <Typography variant="subtitle1" mb={1.25}>
              How to set up {APP_CHOICES.find((choice) => choice.value === app)?.title}
            </Typography>
            <SetupSteps app={app} />
          </Box>
          <Note kind="warning" title="Keep the token private">
            Anyone with your bot's token can read its messages. It is kept only on this computer, in the helper app's
            settings.
          </Note>
          <MoreDetails summary="Turn a chat app off, or allow another person">
            <Typography variant="body2">Allow another account (for example a family member):</Typography>
            <CopyBox text={`browserharness-bridge ${app} allow <their id>`} />
            <Typography variant="body2" mt={1.5}>
              Turn this app off and forget its token:
            </Typography>
            <CopyBox text={`browserharness-bridge ${app} off`} />
            <Typography variant="body2" mt={1.5}>
              See every app at a glance:
            </Typography>
            <CopyBox text="browserharness-bridge chats" />
          </MoreDetails>
        </SettingsCard>

        <SettingsCard
          title="Voice notes"
          intro="Send your bot a voice note instead of typing. It turns your voice into words, does the task, and replies “On it (from your voice note): …” so you can check what it heard."
        >
          <Typography variant="body2">
            It needs a speech-to-text service that you choose: one online with your own key, or one running on this
            computer (then nothing leaves it). BrowserHarness never picks one for you.
          </Typography>
          <CopyBox text="browserharness-bridge voice setup --url <the service's address> --model <its speech-to-text model> --key <your key>" />
          <Typography variant="body2" color="text.secondary">
            Add <code>--language en</code> (or your language) if it hears the wrong language. To turn voice notes off:{" "}
            <code>browserharness-bridge voice off</code>. Works in every app above except email, up to 20 MB per note.
          </Typography>
        </SettingsCard>

        <SettingsCard title="Things you can send your bot" intro="Besides tasks in your own words, the bot understands these right away:">
          <Stack spacing={1}>
            {COMMANDS.map(([command, meaning]) => (
              <Stack key={command} direction={{ xs: "column", sm: "row" }} spacing={{ xs: 0.25, sm: 1.5 }}>
                <Typography component="code" sx={{ fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: "0.88em", minWidth: { sm: 230 }, overflowWrap: "anywhere" }}>
                  {command}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {meaning}
                </Typography>
              </Stack>
            ))}
          </Stack>
          <Typography variant="body2" color="text.secondary">
            You can also run a saved Skill, like <code>/find-red-shoes size 9</code>. Every task also shows up in Task
            history, marked with the app it came from.
          </Typography>
        </SettingsCard>
      </Stack>
    </>
  );
}
