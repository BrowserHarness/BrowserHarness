import { useEffect, useMemo, useState } from "react";
import {
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControl,
  FormHelperText,
  IconButton,
  InputLabel,
  ListSubheader,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography
} from "@mui/material";
import { DeleteIcon, RefreshIcon } from "../icons";
import { MoreDetails, Note, PageTitle, SettingsCard, StatusPill, TechnicalName, useConfirm } from "../kit";
import { SimpleConnect, TestResult } from "../SimpleConnect";
import {
  PROVIDERS,
  hasEditableBaseUrl,
  isLocalProvider,
  isSubscriptionProvider,
  loadConnections,
  loadRoutingConfig,
  providerBaseUrl,
  removeConnection,
  saveRoutingConfig,
  type ProviderConfig,
  type ProviderConnection,
  type ProviderId,
  type RuntimeRoutingConfig
} from "../../settings/provider-store";
import {
  SUBSCRIPTION_MODELS,
  accountLabel,
  loadAccounts,
  makeAccount,
  removeAccount,
  saveAccount,
  type ProviderAccount
} from "../../settings/account-store";
import { discoverModels, type DiscoveredModel } from "../../settings/model-catalog";
import { checkSubscriptionReady, type SubscriptionReadiness } from "../../runtime/subscription-client";
import { ensureEndpointAccess, hasEndpointAccess } from "../../settings/browser-access";
import { isEmbeddingOnly, makeMain, plainProblem, testAndSave, testingMessage, type TestState } from "./connect-ai";
import type { SectionProps } from "./SettingsShell";

const SERVICE_HELP: Partial<Record<ProviderId, string>> = {
  "claude-subscription":
    "Uses your paid Claude plan through the Claude Code app on your computer. Needs the helper app. Slower than the other choices, and it can't look at screenshots.",
  "chatgpt-subscription":
    "Uses your paid ChatGPT plan through the Codex app on your computer. Needs the helper app. Slower than the other choices, and it can't look at screenshots.",
  "lm-studio": "Free and private. The LM Studio app must be running with its server started (Developer tab, Start Server).",
  ollama: "Free and private. The Ollama app must be running. If you get a 403 error, start Ollama with OLLAMA_ORIGINS=chrome-extension://*",
  openai: "Needs a secret key from platform.openai.com (API keys page). You pay OpenAI for what you use.",
  anthropic: "Needs a secret key from console.anthropic.com (API keys page). You pay Anthropic for what you use.",
  openrouter: "If you already have an OpenRouter key. Most people should use the Connect button above instead.",
  nvidia: "Needs a secret key from build.nvidia.com.",
  "openai-compatible": "For Groq, Together, DeepInfra, your own server and other services that say they work like OpenAI."
};

/** "Can chat", "Can use the browser" and so on, for one tested AI. */
function AbilityChips({ connection }: { connection: ProviderConnection }) {
  const chips: { label: string; good: boolean }[] = [];
  if (connection.capabilities.embedding && connection.chatHealth.status === "unknown") {
    chips.push({ label: connection.embeddingHealth.status === "healthy" ? "Helps search memory" : "Memory search check failed", good: connection.embeddingHealth.status === "healthy" });
  } else {
    chips.push({ label: connection.chatHealth.status === "healthy" ? "Can chat" : "Can't chat", good: connection.chatHealth.status === "healthy" });
    if (connection.chatHealth.status === "healthy") {
      chips.push({
        label: connection.agentHealth.status === "healthy" ? "Can use the browser" : "Can't use the browser",
        good: connection.agentHealth.status === "healthy"
      });
    }
    if (connection.capabilities.vision) chips.push({ label: "Can see screenshots", good: true });
  }
  return (
    <Stack direction="row" gap={0.75} flexWrap="wrap">
      {chips.map((chip) => (
        <Chip key={chip.label} size="small" color={chip.good ? "success" : "warning"} variant={chip.good ? "filled" : "outlined"} label={chip.label} />
      ))}
    </Stack>
  );
}

function readinessText(readiness: SubscriptionReadiness | null) {
  if (!readiness) return "Checking… ";
  return readiness.state === "ready" ? "Ready. " : "Not ready yet. ";
}

/** For people with a secret key, a subscription app or their own AI server. */
function MoreWaysToConnect({ onSaved }: { onSaved: () => Promise<void> }) {
  const [provider, setProvider] = useState<ProviderId>("openai");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [models, setModels] = useState<DiscoveredModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [state, setState] = useState<TestState>("idle");
  const [message, setMessage] = useState("");
  const [endpointAccess, setEndpointAccess] = useState(true);
  const [readiness, setReadiness] = useState<SubscriptionReadiness | null>(null);

  const definition = PROVIDERS[provider];
  const effectiveBaseUrl = useMemo(() => providerBaseUrl(provider, baseUrl), [provider, baseUrl]);
  const discoveryAvailable = definition.modelDiscovery === "openai-models";
  const subscription = isSubscriptionProvider(provider);
  const local = isLocalProvider(provider);
  const needsKey = !subscription && !local;
  const editableBaseUrl = hasEditableBaseUrl(provider);
  const readyToDiscover = discoveryAvailable && (!needsKey || Boolean(apiKey.trim())) && Boolean(effectiveBaseUrl);

  const reset = () => {
    setState("idle");
    setMessage("");
  };

  useEffect(() => {
    if (!editableBaseUrl || !effectiveBaseUrl) {
      setEndpointAccess(true);
      return;
    }
    void hasEndpointAccess(effectiveBaseUrl).then(setEndpointAccess);
  }, [provider, effectiveBaseUrl]);

  const recheck = async () => {
    setReadiness(null);
    setReadiness(await checkSubscriptionReady(provider));
  };
  useEffect(() => {
    if (!subscription) {
      setReadiness(null);
      return;
    }
    void recheck();
  }, [provider]);

  const loadModels = async (signal?: AbortSignal) => {
    if (!readyToDiscover) return;
    if (editableBaseUrl && !(await hasEndpointAccess(effectiveBaseUrl))) {
      setEndpointAccess(false);
      setModelsError("Press “Allow BrowserHarness to reach this address” first, so it can list the models there.");
      return;
    }
    setModelsLoading(true);
    setModelsError("");
    try {
      const discovered = await discoverModels({ provider, apiKey, baseUrl: effectiveBaseUrl }, signal);
      setModels(discovered);
      if (discovered.length === 0) {
        setModelsError("Connected, but it listed no models. You can still type the model name yourself.");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setModels([]);
      setModelsError(
        error instanceof Error ? `Could not list the models: ${error.message}` : "Could not list the models from this service."
      );
    } finally {
      if (!signal?.aborted) setModelsLoading(false);
    }
  };

  useEffect(() => {
    if (!readyToDiscover) {
      setModels([]);
      setModelsError("");
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadModels(controller.signal), 700);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [provider, apiKey, effectiveBaseUrl, discoveryAvailable, readyToDiscover]);

  const changeProvider = (next: ProviderId) => {
    setProvider(next);
    setApiKey("");
    setModel(isSubscriptionProvider(next) ? "default" : "");
    setModels([]);
    setModelsError("");
    setBaseUrl(PROVIDERS[next].defaultBaseUrl || "");
    reset();
  };

  const save = async () => {
    if (editableBaseUrl) {
      const granted = await ensureEndpointAccess(effectiveBaseUrl);
      setEndpointAccess(granted);
      if (!granted) {
        setState("error");
        setMessage("Chrome did not allow BrowserHarness to reach this address, so nothing was saved.");
        return;
      }
    }
    const config: ProviderConfig = {
      provider,
      apiKey: apiKey.trim(),
      model: model.trim(),
      baseUrl: editableBaseUrl || provider === "nvidia" ? effectiveBaseUrl : undefined
    };
    setState("testing");
    setMessage(testingMessage(config.model));
    try {
      const outcome = await testAndSave(config);
      if (outcome.state === "success" && needsKey) await saveAccount(makeAccount(provider, config.apiKey, config.baseUrl));
      setState(outcome.state);
      setMessage(outcome.message);
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Something went wrong. Please try again.");
    }
    await onSaved();
  };

  const modelIds = subscription ? SUBSCRIPTION_MODELS[provider] || ["default"] : models.map((entry) => entry.id);
  const groupFor = (id: string) => {
    const kind = models.find((entry) => entry.id === id)?.primaryCapability;
    if (kind === "agent") return "Can use the browser";
    if (kind === "vision") return "Can see screenshots";
    if (kind === "embedding") return "Memory search helpers";
    if (kind === "chat") return "Chat only";
    return "Other";
  };

  return (
    <Stack spacing={2.25}>
      <FormControl fullWidth>
        <InputLabel id="service-label">Service</InputLabel>
        <Select labelId="service-label" label="Service" value={provider} onChange={(event) => changeProvider(event.target.value as ProviderId)}>
          <ListSubheader>Your Claude or ChatGPT plan (needs the helper app)</ListSubheader>
          <MenuItem value="claude-subscription">Claude subscription</MenuItem>
          <MenuItem value="chatgpt-subscription">ChatGPT subscription</MenuItem>
          <ListSubheader>Free AI on this computer</ListSubheader>
          <MenuItem value="lm-studio">LM Studio (on this computer)</MenuItem>
          <MenuItem value="ollama">Ollama (on this computer)</MenuItem>
          <ListSubheader>With a secret key (API key)</ListSubheader>
          <MenuItem value="openai">OpenAI</MenuItem>
          <MenuItem value="anthropic">Anthropic</MenuItem>
          <MenuItem value="openrouter">OpenRouter (paste a key)</MenuItem>
          <MenuItem value="nvidia">NVIDIA</MenuItem>
          <MenuItem value="openai-compatible">Another service that works like OpenAI (Groq and others)</MenuItem>
        </Select>
        <FormHelperText>{SERVICE_HELP[provider]}</FormHelperText>
      </FormControl>

      {(provider === "nvidia" || editableBaseUrl) && (
        <TextField
          label="Server address"
          value={effectiveBaseUrl}
          onChange={(event) => {
            if (editableBaseUrl) {
              setBaseUrl(event.target.value);
              reset();
            }
          }}
          slotProps={{ input: { readOnly: provider === "nvidia" } }}
          helperText={
            provider === "nvidia"
              ? "Filled in for you."
              : local
                ? "Filled in for you. Change it only if your AI app shows a different address."
                : "Copy it from the service's help pages. Example: https://api.groq.com/openai/v1"
          }
          fullWidth
        />
      )}

      {editableBaseUrl && effectiveBaseUrl && !endpointAccess && (
        <Box>
          <Button
            variant="outlined"
            onClick={async () => {
              const granted = await ensureEndpointAccess(effectiveBaseUrl);
              setEndpointAccess(granted);
              if (granted) {
                setModelsError("");
                void loadModels();
              }
            }}
          >
            Allow BrowserHarness to reach this address
          </Button>
          <FormHelperText>Chrome will ask you once. BrowserHarness only talks to this address to reach your AI.</FormHelperText>
        </Box>
      )}

      {subscription && (
        <Note kind={readiness?.state === "ready" ? "success" : readiness ? "warning" : "info"}>
          <strong>{readinessText(readiness)}</strong>
          {readiness?.message}
          <Box mt={0.75}>
            {provider === "claude-subscription"
              ? "The Claude Code app must be installed and signed in on the computer running the helper app. "
              : "The Codex app must be installed and signed in on the computer running the helper app. "}
            BrowserHarness never sees your login.
          </Box>
          <Button size="small" sx={{ mt: 0.75 }} onClick={() => void recheck()}>
            Check again
          </Button>
        </Note>
      )}

      {needsKey && (
        <TextField
          label="Secret key (API key)"
          value={apiKey}
          onChange={(event) => {
            setApiKey(event.target.value);
            reset();
          }}
          type="password"
          autoComplete="off"
          fullWidth
          helperText="Paste the key from the service's website. It is kept only in this Chrome and never shared."
        />
      )}

      <Stack direction="row" spacing={1} alignItems="flex-start">
        <Autocomplete
          freeSolo
          fullWidth
          options={modelIds}
          value={model || null}
          loading={modelsLoading}
          groupBy={subscription ? undefined : groupFor}
          onChange={(_event, value) => {
            setModel(value || "");
            reset();
          }}
          onInputChange={(_event, value) => {
            setModel(value);
            reset();
          }}
          renderInput={(params) => (
            <TextField
              {...params}
              label="Model name"
              placeholder={discoveryAvailable ? "The list fills in by itself" : "Type the model name"}
              error={Boolean(modelsError)}
              helperText={
                modelsError ||
                (models.length > 0
                  ? `${models.length} models found. Choose one from the list.`
                  : discoveryAvailable
                    ? local
                      ? "Start your AI app's server and the list fills in, or type a model name."
                      : "Paste your secret key and the list fills in."
                    : subscription
                      ? "“default” uses your plan's normal model."
                      : "Type the model name from the service's website, for example claude-sonnet-4-5.")
              }
              slotProps={{
                input: {
                  ...params.InputProps,
                  endAdornment: (
                    <>
                      {modelsLoading ? <CircularProgress color="inherit" size={18} /> : null}
                      {params.InputProps.endAdornment}
                    </>
                  )
                }
              }}
            />
          )}
        />
        {discoveryAvailable && (
          <Tooltip title="Load the list again">
            <span>
              <IconButton onClick={() => void loadModels()} disabled={modelsLoading || !readyToDiscover} aria-label="Load the list again" sx={{ mt: 1 }}>
                <RefreshIcon />
              </IconButton>
            </span>
          </Tooltip>
        )}
      </Stack>

      <TestResult state={state} message={message} />

      <Box>
        <Button
          variant="contained"
          size="large"
          onClick={() => void save()}
          disabled={state === "testing" || (needsKey && !apiKey.trim()) || !model.trim() || (editableBaseUrl && !effectiveBaseUrl)}
        >
          {state === "testing" ? "Checking…" : isEmbeddingOnly(model) ? "Test and save as memory helper" : "Test and save"}
        </Button>
      </Box>
    </Stack>
  );
}

/** One dropdown in "Which AI does the work". */
function RoleSelect({
  id,
  label,
  help,
  value,
  empty,
  options,
  onChange
}: {
  id: string;
  label: string;
  help: string;
  value: string;
  empty?: string;
  options: ProviderConnection[];
  onChange: (value: string | undefined) => void;
}) {
  return (
    <FormControl fullWidth>
      <InputLabel id={`${id}-label`} shrink={empty ? true : undefined}>
        {label}
      </InputLabel>
      <Select labelId={`${id}-label`} label={label} value={value} onChange={(event) => onChange(event.target.value || undefined)} displayEmpty={Boolean(empty)} notched={empty ? true : undefined}>
        {empty && <MenuItem value="">{empty}</MenuItem>}
        {options.map((connection) => (
          <MenuItem value={connection.id} key={connection.id}>
            {connection.label}
          </MenuItem>
        ))}
      </Select>
      <FormHelperText>{help}</FormHelperText>
    </FormControl>
  );
}

export function AiPage(_props: SectionProps) {
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [routing, setRouting] = useState<RuntimeRoutingConfig>({});
  const [state, setState] = useState<TestState>("idle");
  const [message, setMessage] = useState("");
  const [dialog, confirm] = useConfirm();

  const refresh = async () => {
    const [saved, currentRouting, services] = await Promise.all([loadConnections(), loadRoutingConfig(), loadAccounts()]);
    setConnections(saved);
    setRouting(currentRouting);
    setAccounts(services);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const connectFromSimple = async (config: ProviderConfig) => {
    if (hasEditableBaseUrl(config.provider) && config.baseUrl) {
      if (!(await ensureEndpointAccess(config.baseUrl))) {
        setState("error");
        setMessage("Chrome did not allow BrowserHarness to reach this AI, so nothing was saved.");
        return;
      }
    }
    await saveAccount(makeAccount(config.provider, config.apiKey, config.baseUrl));
    setState("testing");
    setMessage(testingMessage(config.model));
    const outcome = await testAndSave(config);
    // The model the person just picked is the one the chat should use.
    if (outcome.connection.chatHealth.status === "healthy") await makeMain(outcome.connection);
    setState(outcome.state);
    setMessage(outcome.message);
    await refresh();
  };

  const updateRouting = async (patch: Partial<RuntimeRoutingConfig>) => {
    const next = { ...routing, ...patch };
    if (next.fallbackConnectionId && next.fallbackConnectionId === next.primaryConnectionId) next.fallbackConnectionId = undefined;
    await saveRoutingConfig(next);
    setRouting(next);
  };

  const forgetConnection = async (connection: ProviderConnection) => {
    const ok = await confirm({
      title: "Remove this AI?",
      body: `“${connection.label}” will be removed from your list. You can add it again later.${connection.id === routing.primaryConnectionId ? " It is your main AI, so choose another one afterwards." : ""}`,
      confirmLabel: "Remove",
      danger: true
    });
    if (!ok) return;
    await removeConnection(connection.id);
    await refresh();
  };

  const disconnectAccount = async (account: ProviderAccount) => {
    const ok = await confirm({
      title: `Disconnect ${accountLabel(account)}?`,
      body: "BrowserHarness forgets the sign-in or secret key for this service, and its models leave the model menu. Your AIs you already tested stay in the list below.",
      confirmLabel: "Disconnect",
      danger: true
    });
    if (!ok) return;
    await removeAccount(account.id);
    await refresh();
  };

  const main = connections.find((connection) => connection.id === routing.primaryConnectionId);
  const chatReady = connections.filter((connection) => connection.chatHealth.status === "healthy");
  const memoryHelpers = connections.filter(
    (connection) => connection.capabilities.embedding && connection.embeddingHealth.status === "healthy"
  );

  return (
    <>
      {dialog}
      <PageTitle
        title="Your AI"
        intro="The AI is the “brain” of BrowserHarness: it understands your request and decides what to click and type. Connect one here. You only need to do this once."
      />
      <Stack spacing={2.5}>
        <SettingsCard title="Your AI right now">
          {main ? (
            <Stack spacing={1}>
              <StatusPill state={main.agentHealth.status === "healthy" ? "good" : "waiting"}>
                {main.agentHealth.status === "healthy" ? "Ready to do tasks" : "Can chat, but can't use the browser"}
              </StatusPill>
              <Typography variant="subtitle1" sx={{ overflowWrap: "anywhere" }}>
                {main.label}
              </Typography>
              <AbilityChips connection={main} />
              {main.agentHealth.status !== "healthy" && main.agentHealth.status !== "unknown" && (
                <Note kind="warning">
                  This AI could not show it knows how to use the browser, so tasks on websites may fail. Pick a bigger or
                  newer model below. ({plainProblem(main.agentHealth)})
                </Note>
              )}
              <Typography variant="body2" color="text.secondary">
                You can switch to another AI any time from the model button at the top of the chat.
              </Typography>
            </Stack>
          ) : (
            <Note kind="warning" title="No AI is connected yet">
              BrowserHarness can't do anything until you connect one. Pick one of the choices below.
            </Note>
          )}
        </SettingsCard>

        <SimpleConnect onConnect={connectFromSimple} state={state} message={message} />

        <SettingsCard title="More ways to connect" intro="For people with a secret key (API key), a Claude or ChatGPT subscription, or their own AI server.">
          <MoreDetails summary="Show more ways to connect">
            <MoreWaysToConnect onSaved={refresh} />
          </MoreDetails>
        </SettingsCard>

        {accounts.length > 0 && (
          <SettingsCard title="Services you've connected" intro="Every model from these services is listed in the model button at the top of the chat.">
            <Stack spacing={1}>
              {accounts.map((account) => (
                <Paper key={account.id} variant="outlined" sx={{ p: 1.25, pl: 2, display: "flex", alignItems: "center", gap: 1 }}>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body1" fontWeight={600} noWrap>
                      {accountLabel(account)}
                    </Typography>
                    {account.baseUrl && (
                      <Typography variant="caption" color="text.secondary" noWrap component="div">
                        {account.baseUrl}
                      </Typography>
                    )}
                  </Box>
                  <Button size="small" color="error" variant="outlined" aria-label={`Disconnect ${accountLabel(account)}`} onClick={() => void disconnectAccount(account)}>
                    Disconnect
                  </Button>
                </Paper>
              ))}
            </Stack>
          </SettingsCard>
        )}

        {connections.length > 0 && (
          <SettingsCard title="AIs you've tested" intro="Each AI was checked when you added it. Green means it passed.">
            <Stack spacing={1}>
              {connections.map((connection) => (
                <Paper key={connection.id} variant="outlined" sx={{ p: 1.5, pl: 2 }}>
                  <Stack direction="row" alignItems="flex-start" gap={1}>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
                        <Typography variant="subtitle2" sx={{ overflowWrap: "anywhere" }}>
                          {connection.label}
                        </Typography>
                        {connection.id === routing.primaryConnectionId && <Chip size="small" color="primary" label="Main AI" />}
                        {connection.id === routing.fallbackConnectionId && <Chip size="small" variant="outlined" label="Backup AI" />}
                      </Stack>
                      <Box mt={0.75}>
                        <AbilityChips connection={connection} />
                      </Box>
                    </Box>
                    <Tooltip title="Remove this AI">
                      <IconButton size="small" aria-label={`Remove ${connection.label}`} onClick={() => void forgetConnection(connection)}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                </Paper>
              ))}
            </Stack>
          </SettingsCard>
        )}

        {connections.length > 0 && (
          <SettingsCard title="Which AI does the work" intro="Most people only need a main AI. The other two are optional.">
            <RoleSelect
              id="main-ai"
              label="Main AI"
              help="Does all your tasks. Choose one marked “Can use the browser”."
              value={routing.primaryConnectionId || ""}
              options={chatReady}
              onChange={(value) => void updateRouting({ primaryConnectionId: value })}
            />
            <RoleSelect
              id="backup-ai"
              label="Backup AI"
              help="Only used when the main AI is busy or down for a moment. Recommended: no backup, unless your main AI often says it is busy."
              value={routing.fallbackConnectionId || ""}
              empty="No backup (recommended)"
              options={chatReady.filter((connection) => connection.id !== routing.primaryConnectionId)}
              onChange={(value) => void updateRouting({ fallbackConnectionId: value })}
            />
            <RoleSelect
              id="memory-helper"
              label="Memory search helper"
              help="Helps it find things in your history and Skills by meaning, not only by exact words. Recommended: simple word matching, which needs no setup."
              value={routing.embeddingConnectionId || ""}
              empty="Simple word matching (recommended, no setup)"
              options={memoryHelpers}
              onChange={(value) => void updateRouting({ embeddingConnectionId: value })}
            />
            <TechnicalName name="primary, fallback and embedding model routing" />
          </SettingsCard>
        )}
      </Stack>
    </>
  );
}
