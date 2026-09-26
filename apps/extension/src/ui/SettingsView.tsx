import { useEffect, useMemo, useState } from "react";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import RefreshIcon from "@mui/icons-material/Refresh";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  CircularProgress,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography
} from "@mui/material";
import {
  loadProviderConfig,
  PROVIDERS,
  providerBaseUrl,
  saveProviderConfig,
  type ProviderConfig,
  type ProviderId
} from "../settings/provider-store";
import { discoverModels } from "../settings/model-catalog";

export function SettingsView({ onBack }: { onBack: () => void }) {
  const [provider, setProvider] = useState<ProviderId>("openai");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [saved, setSaved] = useState(false);

  const providerDefinition = PROVIDERS[provider];
  const effectiveBaseUrl = useMemo(
    () => providerBaseUrl(provider, baseUrl),
    [provider, baseUrl]
  );
  const discoveryAvailable =
    providerDefinition.modelDiscovery === "openai-models";

  useEffect(() => {
    void loadProviderConfig().then((config) => {
      if (!config) return;
      setProvider(config.provider);
      setApiKey(config.apiKey);
      setModel(config.model);
      setBaseUrl(
        config.baseUrl ||
          PROVIDERS[config.provider].defaultBaseUrl ||
          ""
      );
    });
  }, []);

  const loadModels = async (signal?: AbortSignal) => {
    if (!discoveryAvailable || !apiKey.trim() || !effectiveBaseUrl) return;

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
      const ids = discovered.map((entry) => entry.id);
      setModels(ids);
      if (ids.length === 1 && !model) {
        setModel(ids[0]);
      }
      if (ids.length === 0) {
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
  };

  const handleSave = async () => {
    const config: ProviderConfig = {
      provider,
      apiKey: apiKey.trim(),
      model: model.trim(),
      baseUrl:
        provider === "openai-compatible" || provider === "nvidia"
          ? effectiveBaseUrl
          : undefined
    };
    await saveProviderConfig(config);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  };

  return (
    <Box sx={{ minHeight: "100vh", p: 2 }}>
      <Stack direction="row" alignItems="center" spacing={1} mb={2}>
        <IconButton onClick={onBack} aria-label="Back to chat">
          <ArrowBackIcon />
        </IconButton>
        <Typography variant="h6">Settings</Typography>
      </Stack>

      <Typography variant="subtitle2" color="text.secondary" mb={1}>
        Models & connections
      </Typography>

      <Stack spacing={2}>
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
            <MenuItem value="openai-compatible">OpenAI-compatible</MenuItem>
          </Select>
        </FormControl>

        {(provider === "nvidia" || provider === "openai-compatible") && (
          <TextField
            label="Base URL"
            value={effectiveBaseUrl}
            onChange={(event) =>
              provider === "openai-compatible"
                ? setBaseUrl(event.target.value)
                : undefined
            }
            slotProps={{
              input: {
                readOnly: provider === "nvidia"
              }
            }}
            helperText={
              provider === "nvidia"
                ? "NVIDIA hosted NIM API endpoint"
                : "Example: https://api.groq.com/openai/v1"
            }
            fullWidth
          />
        )}

        <TextField
          label="API key"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          type="password"
          autoComplete="off"
          fullWidth
          helperText="Stored locally in Chrome extension storage. Model discovery uses this key only with the selected provider."
        />

        <Stack direction="row" spacing={1} alignItems="flex-start">
          <Autocomplete
            freeSolo
            fullWidth
            options={models}
            value={model || null}
            loading={modelsLoading}
            onChange={(_event, value) => setModel(value || "")}
            onInputChange={(_event, value) => setModel(value)}
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
                    ? `${models.length} model${models.length === 1 ? "" : "s"} loaded from provider`
                    : discoveryAvailable
                      ? "Enter your API key to load available models automatically."
                      : "Automatic model discovery is not enabled for this provider yet.")
                }
                slotProps={{
                  input: {
                    ...params.InputProps,
                    endAdornment: (
                      <>
                        {modelsLoading ? (
                          <CircularProgress color="inherit" size={18} />
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
                    modelsLoading || !apiKey.trim() || !effectiveBaseUrl
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

        {saved && (
          <Alert severity="success">
            Connection settings saved locally.
          </Alert>
        )}

        <Button
          variant="contained"
          onClick={handleSave}
          disabled={
            !apiKey.trim() ||
            !model.trim() ||
            (provider === "openai-compatible" && !effectiveBaseUrl)
          }
        >
          Save connection
        </Button>

        <Typography variant="subtitle2" color="text.secondary" sx={{ mt: 2 }}>
          Progressive settings
        </Typography>

        {[
          "Workspaces",
          "Agents",
          "Skills",
          "Workflows",
          "Memory",
          "Browser Access",
          "Permissions",
          "Privacy",
          "Appearance",
          "Advanced",
          "About"
        ].map((item) => (
          <Box
            key={item}
            sx={{ py: 1.25, borderBottom: 1, borderColor: "divider" }}
          >
            <Typography>{item}</Typography>
          </Box>
        ))}
      </Stack>
    </Box>
  );
}
