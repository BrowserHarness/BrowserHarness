import { useEffect, useRef, useState } from "react";
import { Box, Button, Chip, CircularProgress, Paper, Stack, Switch, TextField, Typography } from "@mui/material";
import {
  ChoiceCards,
  CopyBox,
  MoreDetails,
  Note,
  PageTitle,
  SettingsCard,
  StatusPill,
  Steps,
  TechnicalName,
  useConfirm,
  type Choice
} from "../kit";
import {
  BRIDGE_STATUS_KEY,
  DEFAULT_BRIDGE_SETTINGS,
  bridgePermissionUrl,
  loadBridgeSettings,
  loadBridgeStatus,
  saveBridgeSettings,
  type BridgeSettings,
  type BridgeStatus
} from "../../settings/bridge-store";
import { BridgeNotRunningError, requestPairing, waitForPairing } from "../../settings/bridge-pairing";
import { ensureEndpointAccess } from "../../settings/browser-access";
import { getMcpServerTrustMode, setMcpServerTrustMode, type McpServerTrustMode } from "../../settings/mcp-trust-store";
import type { SectionProps } from "./SettingsShell";
import { ProblemCard, SuccessBanner, useSaved } from "../feedback";
import { diagnoseAi, diagnoseHelper } from "../../help/problems";

type PairStep =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "code"; code: string }
  | { kind: "not-running" }
  | { kind: "error"; message: string };

const spaced = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

/** Live state of the helper app: paired or not, and reachable or not. */
export function useHelperApp() {
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [settings, setSettings] = useState<BridgeSettings>(DEFAULT_BRIDGE_SETTINGS);
  useEffect(() => {
    void loadBridgeStatus().then(setStatus);
    void loadBridgeSettings().then(setSettings);
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "session" && changes[BRIDGE_STATUS_KEY]?.newValue) setStatus(changes[BRIDGE_STATUS_KEY].newValue as BridgeStatus);
      if (area === "local") void loadBridgeSettings().then(setSettings);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);
  const connected = settings.enabled && status?.state === "connected";
  return { status, settings, connected, paired: settings.enabled && Boolean(settings.token) };
}

export function HelperStatus({ helper }: { helper: ReturnType<typeof useHelperApp> }) {
  if (helper.connected) return <StatusPill state="good">Connected and working</StatusPill>;
  if (helper.paired) return <StatusPill state="waiting">Paired, but not running right now</StatusPill>;
  return <StatusPill state="off">Not set up</StatusPill>;
}

/** Install once, press Pair, type the code. */
export function PairHelper({ helper }: { helper: ReturnType<typeof useHelperApp> }) {
  const [step, setStep] = useState<PairStep>({ kind: "idle" });
  const cancel = useRef<AbortController | null>(null);
  const [dialog, confirm] = useConfirm();

  useEffect(() => () => cancel.current?.abort(), []);

  const pair = async () => {
    cancel.current?.abort();
    const controller = new AbortController();
    cancel.current = controller;
    setStep({ kind: "asking" });
    try {
      const settings = await loadBridgeSettings();
      const address = settings.address || DEFAULT_BRIDGE_SETTINGS.address;
      const request = await requestPairing(address);
      setStep({ kind: "code", code: request.code });
      const token = await waitForPairing(address, request.request_id, { signal: controller.signal });
      await saveBridgeSettings({ ...settings, address, enabled: true, token });
      setStep({ kind: "idle" });
    } catch (error) {
      if (controller.signal.aborted) return;
      setStep(
        error instanceof BridgeNotRunningError
          ? { kind: "not-running" }
          : { kind: "error", message: error instanceof Error ? error.message : "Pairing didn't work. Please try again." }
      );
    }
  };

  const disconnect = async () => {
    const ok = await confirm({
      title: "Disconnect the helper app?",
      body: "Chat apps, coding tools and Claude or ChatGPT subscriptions stop working until you pair again. Nothing is deleted.",
      confirmLabel: "Disconnect",
      danger: true
    });
    if (!ok) return;
    const settings = await loadBridgeSettings();
    await saveBridgeSettings({ ...settings, enabled: false });
  };

  if (helper.connected) {
    return (
      <Stack spacing={1.5}>
        {dialog}
        <SuccessBanner
          title="Connected"
          action={
            <Button color="error" variant="outlined" size="small" onClick={() => void disconnect()}>
              Disconnect
            </Button>
          }
        >
          The helper app is running and paired with this Chrome.
        </SuccessBanner>
      </Stack>
    );
  }

  return (
    <Stack spacing={2}>
      {dialog}
      <Steps
        steps={[
          <>
            Install <strong>Node.js</strong> (free, from nodejs.org) if this computer doesn't have it. Choose the
            version marked “LTS”.
          </>,
          <>
            Get the helper app download (a file named <code>browserharness-bridge…zip</code>) from the same place you got
            BrowserHarness, and unzip it.
          </>,
          <>
            Open the unzipped folder. On Windows, double-click <strong>install.cmd</strong>. On a Mac or Linux, open
            Terminal in that folder and type:
            <CopyBox text="bash install.sh" />
          </>,
          <>
            The installer asks for a code. Press <strong>Pair</strong> below and type the 6 numbers it shows into the
            installer window.
          </>
        ]}
      />
      {step.kind === "code" ? (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="body2" color="text.secondary">
            Type this code into the installer window (or the window where you ran <code>browserharness-bridge pair</code>):
          </Typography>
          <Typography aria-label="Pairing code" sx={{ fontSize: 34, fontWeight: 700, letterSpacing: 6, my: 1 }}>
            {spaced(step.code)}
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center" role="status">
            <CircularProgress size={16} />
            <Typography variant="body2" color="text.secondary">
              Waiting for you to type it…
            </Typography>
          </Stack>
          <Button sx={{ mt: 1 }} onClick={() => (cancel.current?.abort(), setStep({ kind: "idle" }))}>
            Cancel
          </Button>
        </Paper>
      ) : (
        <Box>
          <Button variant="contained" size="large" onClick={() => void pair()} disabled={step.kind === "asking"}>
            Pair
          </Button>
        </Box>
      )}
      {step.kind === "not-running" && (
        <ProblemCard problem={diagnoseHelper("not-running")} heading="Couldn't pair" onRetry={() => void pair()} retryLabel="Pair again" />
      )}
      {step.kind === "error" && (
        <ProblemCard problem={diagnoseHelper("pairing-failed", step.message)} heading="Couldn't pair" onRetry={() => void pair()} retryLabel="Get a new code" />
      )}
      {helper.paired && !helper.connected && step.kind === "idle" && (
        <ProblemCard problem={diagnoseHelper("not-connected", helper.status?.message)} severity="warning" />
      )}
    </Stack>
  );
}

interface ToolServer {
  id: string;
  label: string;
  enabled: boolean;
  transport: string;
  connected: boolean;
  env_keys: string[];
}

interface ServerTool {
  name: string;
  description?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

async function toolsRequest<T>(input: Record<string, unknown>): Promise<{ ok: boolean; data?: T; error?: { message: string } }> {
  return chrome.runtime.sendMessage({ type: "BROWSER_TOOL", tool: "mcp", input });
}

const TOOL_POLICY: Choice<McpServerTrustMode>[] = [
  {
    value: "allow-read-only",
    title: "Let it look things up, ask before changes",
    recommended: true,
    description: "BrowserHarness may use this app to read and search. Anything that changes something asks you first."
  },
  { value: "ask-all", title: "Ask me every time", description: "Every use of this app waits for your OK." },
  { value: "blocked", title: "Never use this app", description: "BrowserHarness ignores this app completely." }
];

/** Other programs the helper app is set up to talk to (MCP servers). */
function OtherAppTools() {
  const saved = useSaved();
  const [servers, setServers] = useState<ToolServer[]>([]);
  const [policy, setPolicy] = useState<Record<string, McpServerTrustMode>>({});
  const [tools, setTools] = useState<Record<string, ServerTool[]>>({});
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  const refresh = async () => {
    setLoading(true);
    setMessage("");
    try {
      const result = await toolsRequest<{ servers: ToolServer[] }>({ action: "servers" });
      if (!result.ok || !result.data) {
        setServers([]);
        setMessage(result.error?.message || "Could not load the list.");
        return;
      }
      const list = result.data.servers || [];
      setServers(list);
      setPolicy(Object.fromEntries(await Promise.all(list.map(async (server) => [server.id, await getMcpServerTrustMode(server.id)] as const))));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const loadTools = async (id: string) => {
    const result = await toolsRequest<{ tools: ServerTool[] }>({ action: "list_tools", server_id: id });
    if (!result.ok || !result.data) {
      setMessage(result.error?.message || "Could not list what this app can do.");
      return;
    }
    setTools((current) => ({ ...current, [id]: result.data?.tools || [] }));
  };

  if (loading) {
    return (
      <Stack direction="row" spacing={1} alignItems="center">
        <CircularProgress size={16} />
        <Typography variant="body2">Loading…</Typography>
      </Stack>
    );
  }

  return (
    <Stack spacing={2}>
      {message && <Note kind="warning">{message}</Note>}
      {servers.length === 0 ? (
        <Note kind="info">
          None are set up. This is normal: most people never need it. Someone helping you can add them with{" "}
          <code>browserharness-bridge mcp-servers</code>.
        </Note>
      ) : (
        servers.map((server) => (
          <Paper key={server.id} variant="outlined" sx={{ p: 2 }}>
            <Stack spacing={1.5}>
              <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1}>
                <Typography variant="subtitle1" noWrap>
                  {server.label}
                </Typography>
                <StatusPill state={server.connected ? "good" : server.enabled ? "waiting" : "off"}>
                  {server.connected ? "Working" : server.enabled ? "Not reachable" : "Turned off"}
                </StatusPill>
              </Stack>
              <ChoiceCards
                label={`May BrowserHarness use ${server.label}?`}
                choices={TOOL_POLICY}
                value={policy[server.id] || "allow-read-only"}
                onChange={(mode) => {
                  setPolicy((current) => ({ ...current, [server.id]: mode }));
                  void setMcpServerTrustMode(server.id, mode).then(() => saved(`Saved for ${server.label}`));
                }}
              />
              <MoreDetails summary="What can it do?">
                <Stack spacing={1}>
                  <Box>
                    <Button size="small" variant="outlined" disabled={!server.enabled} onClick={() => void loadTools(server.id)}>
                      {tools[server.id] ? "Check again" : "Show the list"}
                    </Button>
                  </Box>
                  {tools[server.id]?.length === 0 && (
                    <Typography variant="body2" color="text.secondary">
                      It offers nothing.
                    </Typography>
                  )}
                  {tools[server.id]?.map((tool) => (
                    <Box key={tool.name}>
                      <Stack direction="row" gap={0.75} alignItems="center" flexWrap="wrap">
                        <Typography variant="body2" fontWeight={600}>
                          {tool.name}
                        </Typography>
                        <Chip
                          size="small"
                          variant="outlined"
                          label={tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true ? "Only reads" : "Asks you first"}
                        />
                      </Stack>
                      {tool.description && (
                        <Typography variant="caption" color="text.secondary">
                          {tool.description}
                        </Typography>
                      )}
                    </Box>
                  ))}
                  <TechnicalName name={`MCP server “${server.id}” (${server.transport})`} />
                </Stack>
              </MoreDetails>
            </Stack>
          </Paper>
        ))
      )}
      <Box>
        <Button size="small" onClick={() => void refresh()}>
          Check again
        </Button>
      </Box>
    </Stack>
  );
}

/** Address and key, for people helping someone with an unusual setup. */
function ConnectionDetails() {
  const [settings, setSettings] = useState<BridgeSettings>(DEFAULT_BRIDGE_SETTINGS);
  const [message, setMessage] = useState<{ kind: "success" | "danger"; text: string } | null>(null);
  const saved = useSaved();

  useEffect(() => {
    void loadBridgeSettings().then(setSettings);
  }, []);

  const save = async () => {
    try {
      if (settings.enabled && !(await ensureEndpointAccess(bridgePermissionUrl(settings.address)))) {
        setMessage({ kind: "danger", text: "Chrome did not allow BrowserHarness to reach that address, so nothing was saved." });
        return;
      }
      await saveBridgeSettings(settings);
      setMessage(null);
      saved(settings.enabled ? "Saved. Connecting to the helper app…" : "Saved. The helper app connection is off");
    } catch (error) {
      setMessage({ kind: "danger", text: error instanceof Error ? error.message : "Could not save." });
    }
  };

  return (
    <Stack spacing={2}>
      <Note kind="info">You don't need this. Pressing Pair fills it in. Change it only if someone helping you asks.</Note>
      <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2}>
        <Box>
          <Typography id="helper-connect-label" variant="subtitle1">
            Connect to the helper app
          </Typography>
          <Typography variant="body2" color="text.secondary">
            When on, BrowserHarness keeps a connection to the helper app at the address below.
          </Typography>
        </Box>
        <Switch
          checked={settings.enabled}
          onChange={(event) => setSettings((current) => ({ ...current, enabled: event.target.checked }))}
          slotProps={{ input: { "aria-labelledby": "helper-connect-label" } }}
        />
      </Stack>
      <TextField
        label="Helper app address"
        value={settings.address}
        onChange={(event) => setSettings((current) => ({ ...current, address: event.target.value }))}
        helperText="Normally ws://127.0.0.1:10087/ws (this computer). Another computer must use an address starting with wss://"
        fullWidth
      />
      <TextField
        label="Pairing key"
        value={settings.token}
        onChange={(event) => setSettings((current) => ({ ...current, token: event.target.value }))}
        type="password"
        autoComplete="off"
        helperText="Made by the helper app when you pair. Kept only in this Chrome."
        fullWidth
      />
      {message?.kind === "danger" && <ProblemCard problem={diagnoseAi(message.text)} heading="Not saved" onRetry={() => void save()} />}
      <Box>
        <Button variant="outlined" onClick={() => void save()}>
          Save
        </Button>
      </Box>
      <TechnicalName name="Local Agent Bridge (WebSocket address and pairing token)" />
    </Stack>
  );
}

export function HelperAppPage({ go }: SectionProps) {
  const helper = useHelperApp();
  return (
    <>
      <PageTitle
        title="Helper app"
        intro="A small free program you install once on this computer. You only need it for the extras below. BrowserHarness works without it."
      />
      <Stack spacing={2.5}>
        <SettingsCard title="What the helper app adds">
          <Stack component="ul" spacing={0.75} sx={{ m: 0, pl: 2.5 }}>
            <Typography component="li" variant="body2">
              <strong>Tasks from your phone:</strong> send tasks from Telegram, Discord, Slack, Signal or email.{" "}
              <Button size="small" onClick={() => go("phone")} sx={{ py: 0 }}>
                Set up
              </Button>
            </Typography>
            <Typography component="li" variant="body2">
              <strong>Your Claude or ChatGPT plan:</strong> use the subscription you already pay for, instead of a
              secret key.
            </Typography>
            <Typography component="li" variant="body2">
              <strong>Coding tools:</strong> let Claude Code, Codex, Cursor or Hermes on this computer use this browser.
            </Typography>
          </Stack>
        </SettingsCard>

        <SettingsCard title="Set it up" action={<HelperStatus helper={helper} />}>
          <PairHelper helper={helper} />
        </SettingsCard>

        <SettingsCard
          title="Coding tools"
          intro="The installer sets up every coding tool it finds on this computer. Restart your coding tool once after installing."
        >
          <Typography variant="body2">
            Then ask it, for example: “Use BrowserHarness to find the cheapest flight from Delhi to Goa next Friday”. In
            Claude Code you can also type <code>/browserharness</code>.
          </Typography>
          <Note kind="tip">Sending, buying, deleting and submitting still wait for your OK here in Chrome.</Note>
          <MoreDetails summary="Useful commands">
            <Typography variant="body2">Is it running, and is Chrome connected?</Typography>
            <CopyBox text="browserharness-bridge status" />
            <Typography variant="body2" mt={1.5}>
              Which coding tools did it find?
            </Typography>
            <CopyBox text="browserharness-bridge agents" />
            <Typography variant="body2" mt={1.5}>
              Pair Chrome again:
            </Typography>
            <CopyBox text="browserharness-bridge pair" />
          </MoreDetails>
        </SettingsCard>

        {helper.connected && (
          <SettingsCard
            title="Tools from other apps"
            intro="If someone set up extra apps for the helper app to talk to (like a notes or files app), choose what BrowserHarness may do with each."
          >
            <OtherAppTools />
          </SettingsCard>
        )}

        <SettingsCard title="Connection details">
          <MoreDetails summary="Show connection details (for people helping you)">
            <ConnectionDetails />
          </MoreDetails>
        </SettingsCard>
      </Stack>
    </>
  );
}
