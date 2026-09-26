import { useEffect, useState } from "react";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import {
  Alert,
  Box,
  Button,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography
} from "@mui/material";
import {
  loadProviderConfig,
  saveProviderConfig,
  type ProviderConfig,
  type ProviderId
} from "../settings/provider-store";

const defaults: Record<ProviderId, string> = {
  openai: "",
  anthropic: "",
  "openai-compatible": ""
};

export function SettingsView({ onBack }: { onBack: () => void }) {
  const [provider, setProvider] = useState<ProviderId>("openai");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void loadProviderConfig().then((config) => {
      if (!config) return;
      setProvider(config.provider);
      setApiKey(config.apiKey);
      setModel(config.model);
      setBaseUrl(config.baseUrl ?? "");
    });
  }, []);

  const handleSave = async () => {
    const config: ProviderConfig = {
      provider,
      apiKey,
      model: model || defaults[provider],
      baseUrl: provider === "openai-compatible" ? baseUrl : undefined
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
            onChange={(event) => setProvider(event.target.value as ProviderId)}
          >
            <MenuItem value="openai">OpenAI</MenuItem>
            <MenuItem value="anthropic">Anthropic</MenuItem>
            <MenuItem value="openai-compatible">OpenAI-compatible</MenuItem>
          </Select>
        </FormControl>

        {provider === "openai-compatible" && (
          <TextField
            label="Base URL"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://example.com/v1"
            fullWidth
          />
        )}

        <TextField
          label="Model"
          value={model}
          onChange={(event) => setModel(event.target.value)}
          placeholder="Provider model ID"
          fullWidth
        />

        <TextField
          label="API key"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          type="password"
          autoComplete="off"
          fullWidth
          helperText="Stored locally in Chrome extension storage. Never commit or paste keys into project files."
        />

        {saved && <Alert severity="success">Connection settings saved locally.</Alert>}
        <Button variant="contained" onClick={handleSave} disabled={!apiKey || !model || (provider === "openai-compatible" && !baseUrl)}>
          Save connection
        </Button>

        <Typography variant="subtitle2" color="text.secondary" sx={{ mt: 2 }}>
          Progressive settings
        </Typography>
        {["Workspaces", "Agents", "Skills", "Workflows", "Memory", "Browser Access", "Permissions", "Privacy", "Appearance", "Advanced", "About"].map(
          (item) => (
            <Box key={item} sx={{ py: 1.25, borderBottom: 1, borderColor: "divider" }}>
              <Typography>{item}</Typography>
            </Box>
          )
        )}
      </Stack>
    </Box>
  );
}
