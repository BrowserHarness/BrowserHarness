import { useEffect, useMemo, useState } from "react";
import { BackIcon, ChevronDownIcon, DeleteIcon, RefreshIcon } from "./icons";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControl,
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
import {
  PROVIDERS,
  createConnection,
  loadConnections,
  loadRoutingConfig,
  providerBaseUrl,
  hasEditableBaseUrl,
  isLocalProvider,
  isSubscriptionProvider,
  removeConnection,
  saveConnection,
  saveRoutingConfig,
  type CapabilityHealth,
  type ProviderConfig,
  type ProviderConnection,
  type ProviderId,
  type RuntimeRoutingConfig
} from "../settings/provider-store";
import {
  SUBSCRIPTION_MODELS,
  accountLabel,
  loadAccounts,
  makeAccount,
  removeAccount,
  saveAccount,
  type ProviderAccount
} from "../settings/account-store";
import {
  discoverModels,
  type DiscoveredModel
} from "../settings/model-catalog";
import {
  classifyModelCapabilities
} from "../settings/model-capabilities";
import {
  checkSubscriptionReady,
  type SubscriptionReadiness
} from "../runtime/subscription-client";
import {
  testAgentCapability,
  testChatCapability,
  testEmbeddingCapability
} from "../runtime/model-client";
import { MvpSettingsSections } from "./MvpSettingsSections";
import { SimpleConnect } from "./SimpleConnect";
import {
  ensureEndpointAccess,
  hasEndpointAccess
} from "../settings/browser-access";

function healthFromError(error: unknown): CapabilityHealth {
  const message = error instanceof Error ? error.message : String(error);
  let status: CapabilityHealth["status"] = "failed";
  if (/429/.test(message)) status = "rate-limited";
  else if (/401|403|unauthorized/i.test(message)) status = "unauthorized";
  else if (/timed out/i.test(message)) status = "timeout";
  return {
    status,
    checkedAt: new Date().toISOString(),
    message
  };
}

function healthChip(
  label: string,
  health: CapabilityHealth
) {
  const color =
    health.status === "healthy"
      ? "success"
      : health.status === "unknown"
        ? "default"
        : "error";
  return (
    <Chip
      size="small"
      color={color}
      variant={health.status === "healthy" ? "filled" : "outlined"}
      label={`${label}: ${health.status}`}
    />
  );
}

export function SettingsView({ onBack }: { onBack: () => void }) {
  const [provider, setProvider] = useState<ProviderId>("openai");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [models, setModels] = useState<DiscoveredModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [connectionState, setConnectionState] = useState<
    "idle" | "testing" | "success" | "error"
  >("idle");
  const [connectionMessage, setConnectionMessage] = useState("");
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [routing, setRouting] = useState<RuntimeRoutingConfig>({});
  const [endpointAccess, setEndpointAccess] = useState(true);
  const [readiness, setReadiness] = useState<SubscriptionReadiness | null>(null);

  const providerDefinition = PROVIDERS[provider];
  const effectiveBaseUrl = useMemo(
    () => providerBaseUrl(provider, baseUrl),
    [provider, baseUrl]
  );
  const discoveryAvailable =
    providerDefinition.modelDiscovery === "openai-models";
  const subscription = isSubscriptionProvider(provider);
  const local = isLocalProvider(provider);
  const needsKey = !subscription && !local;
  const editableBaseUrl = hasEditableBaseUrl(provider);
  const readyToDiscover =
    discoveryAvailable && (!needsKey || Boolean(apiKey.trim())) && Boolean(effectiveBaseUrl);

  const refreshRegistry = async () => {
    const [saved, currentRouting, services] = await Promise.all([
      loadConnections(),
      loadRoutingConfig(),
      loadAccounts()
    ]);
    setConnections(saved);
    setRouting(currentRouting);
    setAccounts(services);
  };

  useEffect(() => {
    void refreshRegistry();
  }, []);

  useEffect(() => {
    if (!editableBaseUrl || !effectiveBaseUrl) {
      setEndpointAccess(true);
      return;
    }

    void hasEndpointAccess(effectiveBaseUrl).then(setEndpointAccess);
  }, [provider, effectiveBaseUrl]);

  const recheckSubscription = async () => {
    setReadiness(null);
    setReadiness(await checkSubscriptionReady(provider));
  };

  useEffect(() => {
    if (!subscription) {
      setReadiness(null);
      return;
    }
    void recheckSubscription();
  }, [provider]);

  const resetConnectionTest = () => {
    setConnectionState("idle");
    setConnectionMessage("");
  };

  const loadModels = async (signal?: AbortSignal) => {
    if (!readyToDiscover) return;

    if (
      editableBaseUrl &&
      !(await hasEndpointAccess(effectiveBaseUrl))
    ) {
      setEndpointAccess(false);
      setModelsError(
        "Grant this custom endpoint permission before BrowserHarness can load its models."
      );
      return;
    }

    setModelsLoading(true);
    setModelsError("");
    try {
      const discovered = await discoverModels(
        {
          provider,
          apiKey,
          baseUrl: effectiveBaseUrl
        },
        signal
      );
      setModels(discovered);

      const agentCandidates = discovered.filter(
        (entry) => entry.capabilities.agent
      );
      if (agentCandidates.length === 1 && !model) {
        setModel(agentCandidates[0].id);
      }

      if (discovered.length === 0) {
        setModelsError(
          "Connected, but this endpoint returned no discoverable models. You can still enter a model ID manually."
        );
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setModels([]);
      setModelsError(
        error instanceof Error
          ? error.message
          : "Could not load models from this provider."
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
    const timer = window.setTimeout(() => {
      void loadModels(controller.signal);
    }, 700);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [provider, apiKey, effectiveBaseUrl, discoveryAvailable, readyToDiscover]);

  const handleProviderChange = (next: ProviderId) => {
    setProvider(next);
    setApiKey("");
    setModel(isSubscriptionProvider(next) ? "default" : "");
    setModels([]);
    setModelsError("");
    setBaseUrl(PROVIDERS[next].defaultBaseUrl || "");
    resetConnectionTest();
  };

  const candidateConfig = (): ProviderConfig => ({
    provider,
    apiKey: apiKey.trim(),
    model: model.trim(),
    baseUrl:
      editableBaseUrl || provider === "nvidia"
        ? effectiveBaseUrl
        : undefined
  });

  const handleTestAndSave = async () => {
    if (editableBaseUrl) {
      const granted = await ensureEndpointAccess(effectiveBaseUrl);
      setEndpointAccess(granted);
      if (!granted) {
        setConnectionState("error");
        setConnectionMessage(
          "Chrome did not grant access to this custom model endpoint."
        );
        return;
      }
    }

    await testAndSave(candidateConfig());
  };

  const testAndSave = async (
    config: ProviderConfig
  ): Promise<ProviderConnection> => {
    const declaredCapabilities =
      classifyModelCapabilities(config.model);
    const embeddingOnly =
      declaredCapabilities.embedding &&
      !declaredCapabilities.chat &&
      !declaredCapabilities.agent &&
      !declaredCapabilities.vision;

    setConnectionState("testing");
    setConnectionMessage(
      embeddingOnly
        ? "Running Embedding capability check…"
        : "Running Chat and Agent capability checks…"
    );

    let chatHealth: CapabilityHealth = {
      status: "unknown"
    };
    let agentHealth: CapabilityHealth = {
      status: "unknown"
    };
    let embeddingHealth: CapabilityHealth = {
      status: "unknown"
    };

    if (embeddingOnly) {
      try {
        const embedding = await testEmbeddingCapability(config);
        embeddingHealth = {
          status: "healthy",
          latencyMs: embedding.latencyMs,
          checkedAt: new Date().toISOString(),
          message: embedding.preview
        };
      } catch (error) {
        embeddingHealth = healthFromError(error);
      }
    } else {
      try {
        const chat = await testChatCapability(config);
        chatHealth = {
          status: "healthy",
          latencyMs: chat.latencyMs,
          checkedAt: new Date().toISOString(),
          message: chat.preview
        };
      } catch (error) {
        chatHealth = healthFromError(error);
      }

      if (chatHealth.status === "healthy") {
        try {
          const agent = await testAgentCapability(config);
          agentHealth = {
            status: "healthy",
            latencyMs: agent.latencyMs,
            checkedAt: new Date().toISOString(),
            message: agent.preview
          };
        } catch (error) {
          agentHealth = healthFromError(error);
        }
      } else {
        agentHealth = {
          status: "failed",
          checkedAt: new Date().toISOString(),
          message:
            "Agent test skipped because Chat capability failed."
        };
      }
    }

    const connection = createConnection(
      {
        ...config,
        validatedAt:
          chatHealth.status === "healthy"
            ? new Date().toISOString()
            : undefined,
        validatedLatencyMs: chatHealth.latencyMs
      },
      { chatHealth, agentHealth, embeddingHealth }
    );

    if (embeddingOnly) {
      connection.capabilities.embedding =
        embeddingHealth.status === "healthy";
      connection.capabilities.unknown = false;
    } else if (chatHealth.status === "healthy") {
      connection.capabilities.chat = true;
      connection.capabilities.agent =
        agentHealth.status === "healthy";
      connection.capabilities.unknown = false;
    }

    await saveConnection(connection);

    const currentRouting = await loadRoutingConfig();
    if (
      embeddingOnly &&
      embeddingHealth.status === "healthy" &&
      !currentRouting.embeddingConnectionId
    ) {
      await saveRoutingConfig({
        ...currentRouting,
        embeddingConnectionId: connection.id
      });
    } else if (
      !embeddingOnly &&
      !currentRouting.primaryConnectionId
    ) {
      await saveRoutingConfig({
        ...currentRouting,
        primaryConnectionId: connection.id
      });
    }

    await refreshRegistry();

    if (embeddingOnly) {
      if (embeddingHealth.status === "healthy") {
        setConnectionState("success");
        setConnectionMessage(
          `Saved. Embedding ✓ ${embeddingHealth.latencyMs} ms · ${embeddingHealth.message || "ready"}`
        );
      } else {
        setConnectionState("error");
        setConnectionMessage(
          `Embedding check failed: ${embeddingHealth.message || embeddingHealth.status}`
        );
      }
    } else if (chatHealth.status === "healthy") {
      setConnectionState("success");
      setConnectionMessage(
        agentHealth.status === "healthy"
          ? `Saved. Chat ✓ ${chatHealth.latencyMs} ms · Agent ✓ ${agentHealth.latencyMs} ms`
          : `Saved for Chat only. Agent check failed: ${agentHealth.message || agentHealth.status}`
      );
    } else {
      setConnectionState("error");
      setConnectionMessage(
        `Not usable for Chat: ${chatHealth.message || chatHealth.status}`
      );
    }
    return connection;
  };

  const connectFromSimple = async (config: ProviderConfig) => {
    if (hasEditableBaseUrl(config.provider) && config.baseUrl) {
      const granted = await ensureEndpointAccess(config.baseUrl);
      if (!granted) {
        setConnectionState("error");
        setConnectionMessage(
          "Chrome did not allow BrowserHarness to reach this model."
        );
        return;
      }
    }
    await saveAccount(makeAccount(config.provider, config.apiKey, config.baseUrl));
    const connection = await testAndSave(config);
    if (connection.chatHealth.status === "healthy") {
      // The model the user just picked is the one the chat should use.
      const current = await loadRoutingConfig();
      await saveRoutingConfig({
        ...current,
        primaryConnectionId: connection.id,
        fallbackConnectionId:
          current.fallbackConnectionId === connection.id
            ? undefined
            : current.fallbackConnectionId
      });
      await refreshRegistry();
    }
  };

  const updateRouting = async (
    patch: Partial<RuntimeRoutingConfig>
  ) => {
    const next = { ...routing, ...patch };
    if (
      next.fallbackConnectionId &&
      next.fallbackConnectionId === next.primaryConnectionId
    ) {
      next.fallbackConnectionId = undefined;
    }
    await saveRoutingConfig(next);
    setRouting(next);
  };

  const handleDelete = async (id: string) => {
    await removeConnection(id);
    await refreshRegistry();
  };

  const modelIds = subscription
    ? SUBSCRIPTION_MODELS[provider] || ["default"]
    : models.map((entry) => entry.id);
  const capabilityFor = (id: string) =>
    models.find((entry) => entry.id === id)?.primaryCapability || "manual";

  return (
    <Box sx={{ minHeight: "100vh", p: 2 }}>
      <Stack direction="row" alignItems="center" spacing={1} mb={2}>
        <IconButton onClick={onBack} aria-label="Back to chat">
          <BackIcon />
        </IconButton>
        <Typography variant="h6">Models & connections</Typography>
      </Stack>

      <Stack spacing={2.5}>
        <SimpleConnect
          onConnect={connectFromSimple}
          state={connectionState}
          message={connectionMessage}
        />

        <Accordion variant="outlined" disableGutters>
          <AccordionSummary expandIcon={<ChevronDownIcon />}>
            <Typography variant="subtitle1">
              Advanced: API keys, other services, technical options
            </Typography>
          </AccordionSummary>
          <AccordionDetails>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack spacing={2}>
            <Typography variant="subtitle1">Add connection</Typography>

            <FormControl fullWidth>
              <InputLabel id="provider-label">Provider</InputLabel>
              <Select
                labelId="provider-label"
                label="Provider"
                value={provider}
                onChange={(event) =>
                  handleProviderChange(event.target.value as ProviderId)
                }
              >
                <ListSubheader>Use your subscription (no API key)</ListSubheader>
                <MenuItem value="claude-subscription">
                  Claude subscription
                </MenuItem>
                <MenuItem value="chatgpt-subscription">
                  ChatGPT subscription
                </MenuItem>
                <ListSubheader>Models on this computer</ListSubheader>
                <MenuItem value="lm-studio">LM Studio (local)</MenuItem>
                <MenuItem value="ollama">Ollama (local)</MenuItem>
                <ListSubheader>API key</ListSubheader>
                <MenuItem value="openai">OpenAI</MenuItem>
                <MenuItem value="anthropic">Anthropic</MenuItem>
                <MenuItem value="openrouter">OpenRouter (paste a key)</MenuItem>
                <MenuItem value="nvidia">NVIDIA</MenuItem>
                <MenuItem value="openai-compatible">
                  OpenAI-compatible (Groq, OpenRouter, others)
                </MenuItem>
              </Select>
            </FormControl>

            {(provider === "nvidia" || editableBaseUrl) && (
              <TextField
                label="Base URL"
                value={effectiveBaseUrl}
                onChange={(event) => {
                  if (editableBaseUrl) {
                    setBaseUrl(event.target.value);
                    resetConnectionTest();
                  }
                }}
                slotProps={{
                  input: { readOnly: provider === "nvidia" }
                }}
                helperText={
                  provider === "nvidia"
                    ? "NVIDIA hosted NIM API endpoint"
                    : local
                      ? "Change this only if your local server uses another port."
                      : "Example: https://api.groq.com/openai/v1"
                }
                fullWidth
              />
            )}

            {editableBaseUrl &&
              effectiveBaseUrl &&
              !endpointAccess && (
                <Button
                  variant="outlined"
                  onClick={async () => {
                    const granted =
                      await ensureEndpointAccess(effectiveBaseUrl);
                    setEndpointAccess(granted);
                    if (granted) {
                      setModelsError("");
                      void loadModels();
                    }
                  }}
                >
                  Grant access to custom endpoint
                </Button>
              )}

            {subscription && (
              <Alert
                severity={
                  readiness?.state === "ready"
                    ? "success"
                    : readiness
                      ? "warning"
                      : "info"
                }
                action={
                  <Button color="inherit" size="small" onClick={() => void recheckSubscription()}>
                    Check again
                  </Button>
                }
              >
                <strong>
                  {readiness
                    ? readiness.state === "ready"
                      ? "Ready. "
                      : "Not ready yet. "
                    : "Checking… "}
                </strong>
                {readiness?.message}
                <br />
                {provider === "claude-subscription"
                  ? "Uses your Claude plan through the Claude Code app, installed and signed in on the computer that runs the Bridge. "
                  : "Uses your ChatGPT plan through the Codex CLI, installed and signed in on the computer that runs the Bridge. "}
                BrowserHarness never sees your login. Text only (no screenshots), and slower per step than an API.
              </Alert>
            )}

            {local && (
              <Alert severity="info">
                {provider === "lm-studio"
                  ? "No API key needed. In LM Studio, load a model, open the Developer tab and start the local server, then pick the model below."
                  : "No API key needed. Run Ollama (ollama serve) with a model pulled. If you see a 403 error, start Ollama with OLLAMA_ORIGINS=chrome-extension://* and try again."}{" "}
                Local models can be slow, so BrowserHarness waits up to two minutes per answer.
              </Alert>
            )}

            {needsKey && (
              <TextField
                label="API key"
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  resetConnectionTest();
                }}
                type="password"
                autoComplete="off"
                fullWidth
                helperText="Stored locally. BrowserHarness never writes provider keys to Git or analytics."
              />
            )}

            <Stack direction="row" spacing={1} alignItems="flex-start">
              <Autocomplete
                freeSolo
                fullWidth
                options={modelIds}
                value={model || null}
                loading={modelsLoading}
                groupBy={(option) => capabilityFor(option)}
                onChange={(_event, value) => {
                  setModel(value || "");
                  resetConnectionTest();
                }}
                onInputChange={(_event, value) => {
                  setModel(value);
                  resetConnectionTest();
                }}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Model"
                    placeholder={
                      discoveryAvailable
                        ? "Models load automatically"
                        : "Enter provider model ID"
                    }
                    error={Boolean(modelsError)}
                    helperText={
                      modelsError ||
                      (models.length > 0
                        ? `${models.length} models loaded and capability-classified`
                        : discoveryAvailable
                          ? local
                            ? "Start the local server to load models, or type a model name."
                            : "Enter the API key to discover models."
                          : "Enter a chat/instruct model ID.")
                    }
                    slotProps={{
                      input: {
                        ...params.InputProps,
                        endAdornment: (
                          <>
                            {modelsLoading ? (
                              <CircularProgress
                                color="inherit"
                                size={18}
                              />
                            ) : null}
                            {params.InputProps.endAdornment}
                          </>
                        )
                      }
                    }}
                  />
                )}
              />

              {discoveryAvailable && (
                <Tooltip title="Reload models">
                  <span>
                    <IconButton
                      onClick={() => void loadModels()}
                      disabled={
                        modelsLoading || !readyToDiscover
                      }
                      aria-label="Reload models"
                      sx={{ mt: 1 }}
                    >
                      <RefreshIcon />
                    </IconButton>
                  </span>
                </Tooltip>
              )}
            </Stack>

            {connectionState === "success" && (
              <Alert severity="success">{connectionMessage}</Alert>
            )}
            {connectionState === "error" && (
              <Alert severity="error">{connectionMessage}</Alert>
            )}
            {connectionState === "testing" && (
              <Alert
                severity="info"
                icon={<CircularProgress size={18} />}
              >
                {connectionMessage}
              </Alert>
            )}

            <Button
              variant="contained"
              onClick={() => void handleTestAndSave()}
              disabled={
                connectionState === "testing" ||
                (needsKey && !apiKey.trim()) ||
                !model.trim() ||
                (editableBaseUrl && !effectiveBaseUrl)
              }
            >
              {connectionState === "testing"
                ? "Testing capabilities…"
                : classifyModelCapabilities(model).embedding &&
                    !classifyModelCapabilities(model).chat &&
                    !classifyModelCapabilities(model).agent
                  ? "Test Embedding & save"
                  : "Test Chat + Agent & save"}
            </Button>
          </Stack>
        </Paper>
          </AccordionDetails>
        </Accordion>

        {accounts.length > 0 && (
          <Stack spacing={1}>
            <Typography variant="subtitle1">Connected services</Typography>
            <Typography variant="body2" color="text.secondary">
              Every model from these services is in the model menu at the top of the chat.
            </Typography>
            {accounts.map((account) => (
              <Paper
                key={account.id}
                variant="outlined"
                sx={{ p: 1.5, display: "flex", alignItems: "center", gap: 1 }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" fontWeight={600} noWrap>
                    {accountLabel(account)}
                  </Typography>
                  {account.baseUrl && (
                    <Typography variant="caption" color="text.secondary" noWrap component="div">
                      {account.baseUrl}
                    </Typography>
                  )}
                </Box>
                <Tooltip title="Disconnect this service and forget its models">
                  <IconButton
                    size="small"
                    aria-label={`Disconnect ${accountLabel(account)}`}
                    onClick={() =>
                      void removeAccount(account.id).then(refreshRegistry)
                    }
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Paper>
            ))}
          </Stack>
        )}

        <Stack spacing={1.5}>
          <Typography variant="subtitle1">
            Saved connections
          </Typography>

          {connections.length === 0 && (
            <Alert severity="info">
              Add and validate at least one chat/instruct model.
            </Alert>
          )}

          {connections.map((connection) => (
            <Paper
              variant="outlined"
              sx={{ p: 1.5 }}
              key={connection.id}
            >
              <Stack spacing={1}>
                <Stack
                  direction="row"
                  justifyContent="space-between"
                  alignItems="flex-start"
                  gap={1}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="subtitle2" noWrap>
                      {connection.label}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                    >
                      {connection.baseUrl ||
                        PROVIDERS[connection.provider]
                          .defaultBaseUrl ||
                        connection.provider}
                    </Typography>
                  </Box>
                  <IconButton
                    size="small"
                    aria-label="Delete connection"
                    onClick={() =>
                      void handleDelete(connection.id)
                    }
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Stack>

                <Stack direction="row" gap={0.75} flexWrap="wrap">
                  {healthChip("Chat", connection.chatHealth)}
                  {healthChip("Agent", connection.agentHealth)}
                  {connection.capabilities.vision && (
                    <Chip
                      size="small"
                      variant="outlined"
                      label="Vision"
                    />
                  )}
                  {connection.capabilities.embedding && (
                    <Chip
                      size="small"
                      variant="outlined"
                      label={`Embedding: ${connection.embeddingHealth.status}`}
                    />
                  )}
                </Stack>
              </Stack>
            </Paper>
          ))}
        </Stack>

        {connections.length > 0 && (
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Stack spacing={2}>
              <Typography variant="subtitle1">
                Runtime routing
              </Typography>

              <FormControl fullWidth>
                <InputLabel id="primary-model-label">
                  Primary
                </InputLabel>
                <Select
                  labelId="primary-model-label"
                  label="Primary"
                  value={routing.primaryConnectionId || ""}
                  onChange={(event) =>
                    void updateRouting({
                      primaryConnectionId:
                        event.target.value || undefined
                    })
                  }
                >
                  {connections
                    .filter(
                      (connection) =>
                        connection.chatHealth.status === "healthy"
                    )
                    .map((connection) => (
                      <MenuItem
                        value={connection.id}
                        key={connection.id}
                      >
                        {connection.label}
                      </MenuItem>
                    ))}
                </Select>
              </FormControl>

              <FormControl fullWidth>
                <InputLabel id="fallback-model-label">
                  Fallback
                </InputLabel>
                <Select
                  labelId="fallback-model-label"
                  label="Fallback"
                  value={routing.fallbackConnectionId || ""}
                  onChange={(event) =>
                    void updateRouting({
                      fallbackConnectionId:
                        event.target.value || undefined
                    })
                  }
                >
                  <MenuItem value="">
                    No fallback
                  </MenuItem>
                  {connections
                    .filter(
                      (connection) =>
                        connection.id !==
                          routing.primaryConnectionId &&
                        connection.chatHealth.status === "healthy"
                    )
                    .map((connection) => (
                      <MenuItem
                        value={connection.id}
                        key={connection.id}
                      >
                        {connection.label}
                      </MenuItem>
                    ))}
                </Select>
              </FormControl>

              <FormControl fullWidth>
                <InputLabel id="embedding-model-label">
                  Embedding
                </InputLabel>
                <Select
                  labelId="embedding-model-label"
                  label="Embedding"
                  value={routing.embeddingConnectionId || ""}
                  onChange={(event) =>
                    void updateRouting({
                      embeddingConnectionId:
                        event.target.value || undefined
                    })
                  }
                >
                  <MenuItem value="">
                    Lexical fallback only
                  </MenuItem>
                  {connections
                    .filter(
                      (connection) =>
                        connection.capabilities.embedding &&
                        connection.embeddingHealth.status ===
                          "healthy"
                    )
                    .map((connection) => (
                      <MenuItem
                        value={connection.id}
                        key={connection.id}
                      >
                        {connection.label}
                      </MenuItem>
                    ))}
                </Select>
              </FormControl>

              <Typography variant="caption" color="text.secondary">
                BrowserHarness tries the Primary once. Only recoverable
                provider failures such as 429, timeout or 5xx can move
                the task to the single Fallback.
              </Typography>
            </Stack>
          </Paper>
        )}

        <MvpSettingsSections />
      </Stack>
    </Box>
  );
}
