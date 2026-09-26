import { useEffect, useMemo, useState } from "react";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import RefreshIcon from "@mui/icons-material/Refresh";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControl,
  IconButton,
  InputLabel,
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
  discoverModels,
  type DiscoveredModel
} from "../settings/model-catalog";
import {
  testAgentCapability,
  testChatCapability
} from "../runtime/model-client";
import { MvpSettingsSections } from "./MvpSettingsSections";
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
  const [routing, setRouting] = useState<RuntimeRoutingConfig>({});
  const [endpointAccess, setEndpointAccess] = useState(true);

  const providerDefinition = PROVIDERS[provider];
  const effectiveBaseUrl = useMemo(
    () => providerBaseUrl(provider, baseUrl),
    [provider, baseUrl]
  );
  const discoveryAvailable =
    providerDefinition.modelDiscovery === "openai-models";

  const refreshRegistry = async () => {
    const [saved, currentRouting] = await Promise.all([
      loadConnections(),
      loadRoutingConfig()
    ]);
    setConnections(saved);
    setRouting(currentRouting);
  };

  useEffect(() => {
    void refreshRegistry();
  }, []);

  useEffect(() => {
    if (provider !== "openai-compatible" || !effectiveBaseUrl) {
      setEndpointAccess(true);
      return;
    }

    void hasEndpointAccess(effectiveBaseUrl).then(setEndpointAccess);
  }, [provider, effectiveBaseUrl]);

  const resetConnectionTest = () => {
    setConnectionState("idle");
    setConnectionMessage("");
  };

  const loadModels = async (signal?: AbortSignal) => {
    if (!discoveryAvailable || !apiKey.trim() || !effectiveBaseUrl) return;

    if (
      provider === "openai-compatible" &&
      !(await hasEndpointAccess(effectiveBaseUrl))
    ) {
      setEndpointAccess(false);
      setModelsError(
        "Grant this custom endpoint permission before BrowserCrew can load its models."
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
    if (!discoveryAvailable || !apiKey.trim() || !effectiveBaseUrl) {
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
  }, [provider, apiKey, effectiveBaseUrl, discoveryAvailable]);

  const handleProviderChange = (next: ProviderId) => {
    setProvider(next);
    setApiKey("");
    setModel("");
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
      provider === "openai-compatible" || provider === "nvidia"
        ? effectiveBaseUrl
        : undefined
  });

  const handleTestAndSave = async () => {
    if (provider === "openai-compatible") {
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

    const config = candidateConfig();
    setConnectionState("testing");
    setConnectionMessage("Running Chat and Agent capability checks…");

    let chatHealth: CapabilityHealth;
    let agentHealth: CapabilityHealth;

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
        message: "Agent test skipped because Chat capability failed."
      };
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
      { chatHealth, agentHealth }
    );

    if (chatHealth.status === "healthy") {
      connection.capabilities.chat = true;
      connection.capabilities.agent =
        agentHealth.status === "healthy";
      connection.capabilities.unknown = false;
    }

    await saveConnection(connection);

    const currentRouting = await loadRoutingConfig();
    if (!currentRouting.primaryConnectionId) {
      await saveRoutingConfig({
        ...currentRouting,
        primaryConnectionId: connection.id
      });
    }

    await refreshRegistry();

    if (chatHealth.status === "healthy") {
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

  const modelIds = models.map((entry) => entry.id);
  const capabilityFor = (id: string) =>
    models.find((entry) => entry.id === id)?.primaryCapability || "manual";

  return (
    <Box sx={{ minHeight: "100vh", p: 2 }}>
      <Stack direction="row" alignItems="center" spacing={1} mb={2}>
        <IconButton onClick={onBack} aria-label="Back to chat">
          <ArrowBackIcon />
        </IconButton>
        <Typography variant="h6">Models & connections</Typography>
      </Stack>

      <Stack spacing={2.5}>
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
                <MenuItem value="openai">OpenAI</MenuItem>
                <MenuItem value="anthropic">Anthropic</MenuItem>
                <MenuItem value="nvidia">NVIDIA</MenuItem>
                <MenuItem value="openai-compatible">
                  OpenAI-compatible
                </MenuItem>
              </Select>
            </FormControl>

            {(provider === "nvidia" ||
              provider === "openai-compatible") && (
              <TextField
                label="Base URL"
                value={effectiveBaseUrl}
                onChange={(event) => {
                  if (provider === "openai-compatible") {
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
                    : "Example: https://api.groq.com/openai/v1"
                }
                fullWidth
              />
            )}

            {provider === "openai-compatible" &&
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
              helperText="Stored locally. BrowserCrew never writes provider keys to Git or analytics."
            />

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
                          ? "Enter the API key to discover models."
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
                        modelsLoading ||
                        !apiKey.trim() ||
                        !effectiveBaseUrl
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
                !apiKey.trim() ||
                !model.trim() ||
                (provider === "openai-compatible" &&
                  !effectiveBaseUrl)
              }
            >
              {connectionState === "testing"
                ? "Testing capabilities…"
                : "Test Chat + Agent & save"}
            </Button>
          </Stack>
        </Paper>

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
                    <DeleteOutlineIcon fontSize="small" />
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

              <Typography variant="caption" color="text.secondary">
                BrowserCrew tries the Primary once. Only recoverable
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
