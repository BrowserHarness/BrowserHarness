import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Box, Button, CircularProgress, Paper, Stack, TextField, Typography } from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import { ChoiceCards, CopyBox, MoreDetails, Note, PageTitle, SettingsCard, StatusPill, Steps, useConfirm, type Choice } from "../kit";
import { ProblemCard, SuccessBanner, useSaved } from "../feedback";
import { diagnoseChatApp, type Problem } from "../../help/problems";
import { CHAT_APP_LABELS, type ChatApp } from "../../runtime/schedules";
import { HelperStatus, useHelperApp } from "./HelperAppPage";
import type { SectionProps } from "./SettingsShell";

const APP_CHOICES: Choice<ChatApp>[] = [
  { value: "telegram", title: "Telegram", recommended: true, description: "The easiest. About 2 minutes, all from your phone." },
  { value: "discord", title: "Discord", description: "If you already use Discord. You make a bot on Discord's website." },
  { value: "slack", title: "Slack", description: "For work Slack. Takes about 10 minutes on Slack's website." },
  { value: "signal", title: "Signal", description: "Needs a spare phone number for the bot and an extra program." },
  { value: "email", title: "Email", description: "Email tasks to a separate mailbox made just for the bot." },
  { value: "mattermost", title: "Mattermost", description: "If your team uses Mattermost." },
  { value: "matrix", title: "Matrix", description: "For Element and other Matrix apps." }
];

interface Person {
  id: string;
  name: string;
}

interface ChatAppState {
  app: ChatApp;
  set_up: boolean;
  running: boolean;
  bot?: string;
  team?: string;
  number?: string;
  address?: string;
  invite?: string;
  allowed: Person[];
  waiting: (Person & { at: string })[];
}

interface ChatStatus {
  apps: Partial<Record<ChatApp, ChatAppState>>;
  voice_notes: boolean;
}

interface HelperReply<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/** Asks the helper app on this computer; tokens go there and nowhere else. */
async function askHelper<T>(action: "status" | "setup" | "allow" | "remove" | "off", args: Record<string, string> = {}): Promise<HelperReply<T>> {
  try {
    const reply = (await chrome.runtime.sendMessage({ type: "BRIDGE_CHAT", action, args })) as HelperReply<T> | undefined;
    return reply || { ok: false, error: { code: "BRIDGE_DISCONNECTED", message: "No answer" } };
  } catch (error) {
    return { ok: false, error: { code: "BRIDGE_DISCONNECTED", message: error instanceof Error ? error.message : String(error) } };
  }
}

/** Which chat apps are set up and who may use them, kept fresh while the page is open. */
function useChatApps(connected: boolean) {
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [error, setError] = useState<HelperReply<unknown>["error"] | null>(null);
  const refresh = useCallback(async () => {
    const reply = await askHelper<ChatStatus>("status");
    if (reply.ok && reply.data) {
      setStatus(reply.data);
      setError(null);
    } else {
      setError(reply.error || null);
    }
  }, []);
  useEffect(() => {
    if (!connected) {
      setStatus(null);
      setError(null);
      return;
    }
    void refresh();
    // New people appear under "People waiting" a moment after they message the bot.
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 3000);
    return () => clearInterval(timer);
  }, [connected, refresh]);
  return { status, error, refresh, setStatus };
}

interface Field {
  key: string;
  label: string;
  help: string;
  secret?: boolean;
  placeholder?: string;
}

const FIELDS: Record<ChatApp, Field[]> = {
  telegram: [{ key: "token", label: "Your bot's token", help: "The long code BotFather sent you, like 123456789:AAH…", secret: true }],
  discord: [{ key: "token", label: "Your bot's token", help: "From the Bot page on the Discord Developer Portal.", secret: true }],
  slack: [
    { key: "bot_token", label: "Bot code (starts with xoxb-)", help: "From OAuth & Permissions, after Install to Workspace.", secret: true, placeholder: "xoxb-…" },
    { key: "app_token", label: "App code (starts with xapp-)", help: "From Basic Information, under App-Level Tokens.", secret: true, placeholder: "xapp-…" }
  ],
  signal: [{ key: "number", label: "The bot's phone number", help: "The spare number, with + and the country code. Not your own number.", placeholder: "+15551234567" }],
  email: [
    { key: "address", label: "The bot's email address", help: "A new mailbox made just for the bot, not your own.", placeholder: "my-bot@gmail.com" },
    { key: "password", label: "App password", help: "Made in that mailbox's security settings. Not its normal password.", secret: true }
  ],
  mattermost: [
    { key: "server", label: "Mattermost address", help: "The address you open Mattermost at.", placeholder: "https://chat.example.com" },
    { key: "token", label: "The bot's token", help: "From Integrations, then Bot Accounts.", secret: true }
  ],
  matrix: [
    { key: "homeserver", label: "Matrix server address", help: "The server the bot's account is on. For most people this is https://matrix.org.", placeholder: "https://matrix.org" },
    { key: "token", label: "The bot account's access token", help: "In Element, signed in as the bot: Settings, Help & About.", secret: true }
  ]
};

const MAIL_SERVER_FIELDS: Field[] = [
  { key: "imap", label: "Incoming mail server (IMAP)", help: "From your provider's help pages.", placeholder: "imap.example.com:993" },
  { key: "smtp", label: "Outgoing mail server (SMTP)", help: "From your provider's help pages.", placeholder: "smtp.example.com:465" }
];

/** How to make the bot, up to the code to paste. */
const HOW_TO: Record<ChatApp, ReactNode[]> = {
  telegram: [
    <>
      In Telegram, search for <strong>@BotFather</strong> (it has a blue tick), open it and send <code>/newbot</code>.
    </>,
    <>Choose a name and a username for your bot. BotFather replies with a long code called a token. Copy it.</>,
    <>Paste it below and press Connect.</>
  ],
  discord: [
    <>
      Open the Discord Developer Portal (discord.com/developers/applications), choose <strong>New Application</strong> and give
      it a name.
    </>,
    <>
      Open <strong>Bot</strong>, press <strong>Reset Token</strong> and copy the token.
    </>,
    <>Paste it below and press Connect. Then add the bot to a Discord server you own with the button that appears.</>
  ],
  slack: [
    <>
      Open api.slack.com/apps and choose <strong>Create New App</strong>, then <strong>From scratch</strong>.
    </>,
    <>
      Turn on <strong>Socket Mode</strong> and make an app-level token with <code>connections:write</code>. Copy it (it starts
      with <code>xapp-</code>).
    </>,
    <>
      Under <strong>OAuth &amp; Permissions</strong>, add <code>chat:write</code>, <code>im:history</code>,{" "}
      <code>app_mentions:read</code> and <code>files:read</code>.
    </>,
    <>
      Under <strong>Event Subscriptions</strong>, turn them on and add <code>message.im</code> and <code>app_mention</code>.
      Under <strong>App Home</strong>, turn on the Messages tab.
    </>,
    <>
      Press <strong>Install to Workspace</strong> and copy the Bot User OAuth Token (it starts with <code>xoxb-</code>).
    </>,
    <>Paste both codes below and press Connect.</>
  ],
  signal: [
    <>Get a spare phone number for the bot. Your own number can't be the bot.</>,
    <>Install the free program signal-cli (github.com/AsamK/signal-cli) on this computer and register the spare number with it, following its guide.</>,
    <>Type the bot's number below and press Connect.</>
  ],
  email: [
    <>
      Make a new mailbox just for the bot (for example a new Gmail account). Don't use your own: the bot marks mail as read and
      replies from it.
    </>,
    <>
      In that mailbox, turn on two-step sign-in and make an <strong>app password</strong> (Gmail: Google Account, Security, App
      passwords).
    </>,
    <>Type the bot's address and the app password below and press Connect.</>
  ],
  mattermost: [
    <>
      In Mattermost, open <strong>Integrations</strong>, <strong>Bot Accounts</strong>, <strong>Add Bot Account</strong>, and
      copy its access token.
    </>,
    <>Type your Mattermost address, paste the token below and press Connect.</>
  ],
  matrix: [
    <>
      Make a separate Matrix account for the bot and copy its access token (in Element: Settings, Help &amp; About, Access
      Token).
    </>,
    <>Type its server address, paste the token below and press Connect.</>
  ]
};

/** Apps where a stranger's message reaches the bot, so people can be allowed from "People waiting". */
const MESSAGE_FIRST: Record<ChatApp, boolean> = {
  telegram: true,
  discord: true,
  slack: true,
  signal: true,
  mattermost: true,
  email: true,
  matrix: false
};

const ID_LABEL: Record<ChatApp, string> = {
  telegram: "Telegram user number",
  discord: "Discord user number",
  slack: "Slack member ID",
  signal: "Phone number",
  mattermost: "Mattermost user ID",
  matrix: "Matrix address",
  email: "Email address"
};

const ALLOW_HINT: Record<ChatApp, string> = {
  telegram: "987654321",
  discord: "123456789012345678",
  slack: "U0123ABCD",
  signal: "+15551234567",
  mattermost: "abc123…",
  matrix: "@you:matrix.org",
  email: "you@example.com"
};

const SETUP_COMMAND: Record<ChatApp, string> = {
  telegram: "browserharness-bridge telegram setup --token <the token from BotFather>",
  discord: "browserharness-bridge discord setup --token <the bot token>",
  slack: "browserharness-bridge slack setup --bot-token <xoxb-…> --app-token <xapp-…>",
  signal: "browserharness-bridge signal setup --number <the bot's number> --command <where signal-cli is>",
  email: "browserharness-bridge email setup --address <the bot's address> --password <the app password>",
  mattermost: "browserharness-bridge mattermost setup --server <https://your.mattermost.address> --token <the bot's token>",
  matrix: "browserharness-bridge matrix setup --homeserver <https://matrix.org> --token <the bot's token>"
};

const COMMANDS: [string, string][] = [
  ["/status", "What's running now, and your next scheduled tasks"],
  ["/stop", "Stop the tasks you started from this app"],
  ["/schedule every weekday at 8am check my inbox", "Run a task by itself on a schedule, and send you the result"],
  ["/schedules", "Your scheduled tasks, numbered"],
  ["/unschedule 2", "Turn off the second one"],
  ["/help", "What the bot can do"]
];

function ago(iso: string): string {
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

/** What to do right after the bot is connected. */
function nextStep(app: ChatApp, state: ChatAppState): string {
  const bot = state.bot || state.number || state.address || "your bot";
  if (app === "email") return `Now type your own email address under “Add a person” and press Allow. Then email ${bot} a task.`;
  if (app === "matrix") return `Now type your own Matrix address under “Add a person” and press Allow. Then invite ${bot} to a room with encryption turned off.`;
  if (app === "discord") return `Now add ${bot} to a server you own with the button below, then send it a direct message. You'll appear under “People waiting”.`;
  return `Now send ${bot} any message from your phone. You'll appear under “People waiting” in a few seconds. Press Allow.`;
}

function appPill(state: ChatAppState | undefined): { tone: "good" | "waiting" | "off"; text: string } {
  if (!state?.set_up) return { tone: "off", text: "Not set up" };
  if (!state.running) return { tone: "waiting", text: "Set up, not running" };
  if (state.waiting.length) return { tone: "waiting", text: `${state.waiting.length} waiting` };
  if (!state.allowed.length) return { tone: "waiting", text: "Allow yourself" };
  return { tone: "good", text: "On" };
}

/** The boxes for one app's bot details, and Connect. */
function SetupForm({ app, disabled, onConnected, onCancel }: { app: ChatApp; disabled: boolean; onConnected: (state: ChatAppState) => void; onCancel?: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const label = CHAT_APP_LABELS[app];
  const fields = FIELDS[app];
  const ready = fields.every((field) => (values[field.key] || "").trim());

  const connect = async () => {
    setBusy(true);
    setProblem(null);
    const reply = await askHelper<ChatAppState>("setup", { app, ...values });
    setBusy(false);
    if (reply.ok && reply.data) {
      setValues({});
      onConnected(reply.data);
    } else {
      setProblem(diagnoseChatApp(app, reply.error));
    }
  };

  const box = (field: Field) => (
    <TextField
      key={field.key}
      label={field.label}
      helperText={field.help}
      placeholder={field.placeholder}
      type={field.secret ? "password" : "text"}
      autoComplete="off"
      spellCheck={false}
      value={values[field.key] || ""}
      disabled={disabled || busy}
      onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
      fullWidth
    />
  );

  return (
    <Stack spacing={1.75} component="form" onSubmit={(event) => (event.preventDefault(), ready && void connect())}>
      {fields.map(box)}
      {app === "email" && (
        <MoreDetails summary="Mail server addresses (only if asked)">
          <Stack spacing={1.75}>
            <Typography variant="body2" color="text.secondary">
              Gmail, Outlook, Yahoo, iCloud and a few others are known already. Fill these in only if BrowserHarness asks.
            </Typography>
            {MAIL_SERVER_FIELDS.map(box)}
          </Stack>
        </MoreDetails>
      )}
      {app === "signal" && (
        <Typography variant="body2" color="text.secondary">
          signal-cli must be installed where this computer can find it. If you put it somewhere else, use the command for people
          who use a terminal below.
        </Typography>
      )}
      {problem && <ProblemCard problem={problem} heading="Couldn't connect" onRetry={ready ? () => void connect() : undefined} />}
      <Stack direction="row" spacing={1} alignItems="center">
        <Button type="submit" variant="contained" disabled={disabled || busy || !ready} startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}>
          {busy ? `Checking with ${label}…` : "Connect"}
        </Button>
        {onCancel && (
          <Button onClick={onCancel} disabled={busy}>
            Keep the current bot
          </Button>
        )}
      </Stack>
    </Stack>
  );
}

/** One person in the "can use your bot" or "waiting" list. */
function PersonRow({ person, note, action }: { person: Person; note?: string; action: ReactNode }) {
  return (
    <Stack direction="row" spacing={1.5} alignItems="center" data-person={person.id}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" fontWeight={600} noWrap>
          {person.name || "Someone"}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
          {person.id}
          {note ? ` · ${note}` : ""}
        </Typography>
      </Box>
      {action}
    </Stack>
  );
}

/** A set-up app: its bot, who can use it, and turning it off. */
function AppPanel({ app, state, fresh, onChange, onChangeBot }: { app: ChatApp; state: ChatAppState; fresh: boolean; onChange: (state: ChatAppState) => void; onChangeBot: () => void }) {
  const theme = useTheme();
  const saved = useSaved();
  const [dialog, confirm] = useConfirm();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const label = CHAT_APP_LABELS[app];
  const bot = state.bot || state.number || state.address;

  const run = async (key: string, action: "allow" | "remove" | "off", args: Record<string, string>, note: string) => {
    setBusy(key);
    setProblem(null);
    const reply = await askHelper<ChatAppState>(action, { app, ...args });
    setBusy("");
    if (reply.ok && reply.data) {
      onChange(reply.data);
      saved(note);
      return true;
    }
    setProblem(diagnoseChatApp(app, reply.error));
    return false;
  };

  const allow = (person: Person) => run(`allow:${person.id}`, "allow", { id: person.id, name: person.name }, `${person.name || person.id} can use your bot now`);

  const remove = async (person: Person) => {
    const ok = await confirm({
      title: `Stop ${person.name || person.id} using your bot?`,
      body: "Their messages will get “this bot is private” again. You can allow them again any time.",
      confirmLabel: "Remove",
      danger: true
    });
    if (ok) await run(`remove:${person.id}`, "remove", { id: person.id }, `${person.name || person.id} was removed`);
  };

  const turnOff = async () => {
    const ok = await confirm({
      title: `Turn off ${label}?`,
      body: "Your bot stops answering, and BrowserHarness forgets its token and who could use it. You can set it up again any time.",
      confirmLabel: `Turn off ${label}`,
      danger: true
    });
    if (ok) await run("off", "off", {}, `${label} is off`);
  };

  return (
    <Stack spacing={2}>
      {dialog}
      {fresh && state.allowed.length === 0 ? (
        <SuccessBanner title={`${label} is connected`}>
          {bot ? <>Your bot is {bot}. </> : null}
          {nextStep(app, state)}
        </SuccessBanner>
      ) : fresh ? (
        <SuccessBanner title="You're all set">
          Send {bot || "your bot"} a task from your phone, like “check my inbox for invoices”.
        </SuccessBanner>
      ) : (
        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
          <StatusPill state={appPill(state).tone}>{appPill(state).text}</StatusPill>
          {bot && (
            <Typography variant="body2" color="text.secondary">
              Your bot: <strong>{bot}</strong>
              {state.team ? ` in ${state.team}` : ""}
            </Typography>
          )}
        </Stack>
      )}
      {state.invite && (
        <Box>
          <Button variant="outlined" href={state.invite} target="_blank" rel="noreferrer">
            Add the bot to your Discord server
          </Button>
        </Box>
      )}

      {state.waiting.length > 0 && (
        <Paper
          variant="outlined"
          data-testid="people-waiting"
          sx={{ p: 1.75, borderColor: alpha(theme.palette.warning.main, 0.5), bgcolor: alpha(theme.palette.warning.main, theme.palette.mode === "dark" ? 0.1 : 0.05) }}
        >
          <Typography variant="subtitle1" mb={0.25}>
            People waiting
          </Typography>
          <Typography variant="body2" color="text.secondary" mb={1.25}>
            They messaged your bot and were told it is private. Only allow people you know.
          </Typography>
          <Stack spacing={1.25}>
            {state.waiting.map((person) => (
              <PersonRow
                key={person.id}
                person={person}
                note={`messaged ${ago(person.at)}`}
                action={
                  <Button variant="contained" size="small" disabled={Boolean(busy)} onClick={() => void allow(person)} aria-label={`Allow ${person.name || person.id}`}>
                    {busy === `allow:${person.id}` ? "Allowing…" : "Allow"}
                  </Button>
                }
              />
            ))}
          </Stack>
        </Paper>
      )}

      <Box>
        <Typography variant="subtitle1" mb={0.5}>
          People who can use your bot
        </Typography>
        {state.allowed.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            Nobody yet.{" "}
            {MESSAGE_FIRST[app]
              ? `Send ${bot || "your bot"} any message from your phone, and you'll appear under “People waiting” above.`
              : "Type your own address below and press Allow."}
          </Typography>
        ) : (
          <Stack spacing={1.25} data-testid="people-allowed">
            {state.allowed.map((person) => (
              <PersonRow
                key={person.id}
                person={person}
                action={
                  <Button size="small" color="inherit" disabled={Boolean(busy)} onClick={() => void remove(person)} aria-label={`Remove ${person.name || person.id}`}>
                    Remove
                  </Button>
                }
              />
            ))}
          </Stack>
        )}
      </Box>

      <Stack
        component="form"
        direction={{ xs: "column", sm: "row" }}
        spacing={1}
        alignItems={{ xs: "stretch", sm: "flex-start" }}
        onSubmit={(event) => {
          event.preventDefault();
          if (typed.trim()) void allow({ id: typed.trim(), name: "" }).then((ok) => ok && setTyped(""));
        }}
      >
        <TextField
          label="Add a person"
          placeholder={ALLOW_HINT[app]}
          helperText={`Their ${ID_LABEL[app]}.${MESSAGE_FIRST[app] ? " Easier: have them message the bot, then press Allow above." : ""}`}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          size="small"
          sx={{ flex: 1 }}
        />
        <Button type="submit" variant="outlined" disabled={!typed.trim() || Boolean(busy)} sx={{ mt: { sm: 0.25 } }}>
          Allow
        </Button>
      </Stack>

      {problem && <ProblemCard problem={problem} heading="That didn't work" />}

      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Button onClick={onChangeBot} disabled={Boolean(busy)}>
          Use a different bot
        </Button>
        <Button color="error" onClick={() => void turnOff()} disabled={Boolean(busy)}>
          Turn off {label}
        </Button>
      </Stack>
    </Stack>
  );
}

export function PhonePage({ go }: SectionProps) {
  const helper = useHelperApp();
  const chats = useChatApps(helper.connected);
  const [app, setApp] = useState<ChatApp>("telegram");
  const [changing, setChanging] = useState<ChatApp | null>(null);
  const [fresh, setFresh] = useState<ChatApp | null>(null);
  const label = CHAT_APP_LABELS[app];
  // An older helper app only reports which apps run; the details come from the new one.
  const fallback = new Set((helper.connected ? helper.status?.chat_apps || [] : []).filter((name) => name in CHAT_APP_LABELS));
  const state = chats.status?.apps[app];
  const loadProblem = chats.error && helper.connected ? diagnoseChatApp(app, chats.error) : null;

  const update = (next: ChatAppState) => {
    chats.setStatus((current) => (current ? { ...current, apps: { ...current.apps, [next.app]: next } } : current));
    void chats.refresh();
  };

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
            Only the people you allow can use it. Everyone else is told “this bot is private”. Anything that needs your OK, like
            paying, sending or deleting, waits for you at the computer.
          </Note>
        </SettingsCard>

        <SettingsCard title="Your chat apps" intro={helper.connected ? "Tap one to set it up or change it." : "Connect the helper app to see which apps are on."}>
          <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: { xs: "1fr 1fr", sm: "repeat(4, 1fr)" } }}>
            {APP_CHOICES.map((choice) => {
              const known = chats.status?.apps[choice.value];
              const pill = known ? appPill(known) : fallback.has(choice.value) ? { tone: "good" as const, text: "On" } : { tone: "off" as const, text: "Not set up" };
              return (
                <Paper
                  key={choice.value}
                  variant="outlined"
                  component="button"
                  type="button"
                  onClick={() => setApp(choice.value)}
                  aria-label={`${choice.title}: ${pill.text}`}
                  sx={{
                    p: 1.25,
                    textAlign: "left",
                    cursor: "pointer",
                    font: "inherit",
                    color: "inherit",
                    bgcolor: "background.paper",
                    borderColor: app === choice.value ? "primary.main" : undefined,
                    borderWidth: app === choice.value ? 2 : 1
                  }}
                >
                  <Typography variant="body2" fontWeight={600}>
                    {choice.title}
                  </Typography>
                  <StatusPill state={pill.tone}>{pill.text}</StatusPill>
                </Paper>
              );
            })}
          </Box>
        </SettingsCard>

        <SettingsCard title="Set up a chat app">
          <ChoiceCards label="Which app do you want to use?" choices={APP_CHOICES} value={app} onChange={setApp} columns={2} />
          {!helper.connected && (
            <Note kind="warning" title="First, set up the helper app">
              Chat apps run through the helper app on this computer. Set it up, then come back here.
            </Note>
          )}
          {loadProblem && <ProblemCard problem={loadProblem} heading="Can't show your chat apps" onRetry={() => void chats.refresh()} retryLabel="Check again" />}
          {helper.connected && !chats.status && !chats.error && (
            <Stack direction="row" spacing={1} alignItems="center">
              <CircularProgress size={18} />
              <Typography variant="body2">Asking the helper app…</Typography>
            </Stack>
          )}
          {state?.set_up && changing !== app ? (
            <Box data-testid="chat-app-panel">
              <Typography variant="subtitle1" mb={1.25}>
                {label}
              </Typography>
              <AppPanel
                key={app}
                app={app}
                state={state}
                fresh={fresh === app}
                onChange={(next) => {
                  if (!next.set_up) setFresh(null);
                  update(next);
                }}
                onChangeBot={() => setChanging(app)}
              />
            </Box>
          ) : (
            <Box>
              <Typography variant="subtitle1" mb={1.25}>
                How to set up {label}
              </Typography>
              <Steps steps={HOW_TO[app]} />
              <Box mt={2}>
                <SetupForm
                  key={app}
                  app={app}
                  disabled={!helper.connected || !chats.status}
                  onCancel={changing === app ? () => setChanging(null) : undefined}
                  onConnected={(next) => {
                    setChanging(null);
                    setFresh(app);
                    update(next);
                  }}
                />
              </Box>
            </Box>
          )}
          <Note kind="warning" title="Keep the token private">
            Anyone with your bot's token can read its messages. It is kept only on this computer, by the helper app, and never shown
            again.
          </Note>
          <MoreDetails summary="Commands, for people who use a terminal">
            <Typography variant="body2">Set up {label}:</Typography>
            <CopyBox text={SETUP_COMMAND[app]} />
            <Typography variant="body2" mt={1.5}>
              Allow someone:
            </Typography>
            <CopyBox text={`browserharness-bridge ${app} allow <their ${ID_LABEL[app].toLowerCase()}>`} />
            <Typography variant="body2" mt={1.5}>
              Turn {label} off and forget its token:
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
          <StatusPill state={chats.status?.voice_notes ? "good" : "off"}>{chats.status?.voice_notes ? "On" : "Off"}</StatusPill>
          <Typography variant="body2">
            It needs a speech-to-text service that you choose: one online with your own key, or one running on this computer (then
            nothing leaves it). BrowserHarness never picks one for you. For now, voice notes are turned on with a command on this
            computer:
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
            You can also run a saved Skill, like <code>/find-red-shoes size 9</code>. Every task also shows up in Task history,
            marked with the app it came from.
          </Typography>
        </SettingsCard>
      </Stack>
    </>
  );
}
