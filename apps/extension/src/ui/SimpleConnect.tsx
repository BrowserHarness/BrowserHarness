import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Paper,
  Stack,
  Typography
} from "@mui/material";
import {
  PROVIDERS,
  type ProviderConfig,
  type ProviderId
} from "../settings/provider-store";
import { discoverModels } from "../settings/model-catalog";
import { connectWithOpenRouter } from "../settings/openrouter-oauth";

interface LocalFound {
  provider: Extract<ProviderId, "lm-studio" | "ollama">;
  baseUrl: string;
  model: string;
}

export const OPENROUTER_DEFAULT_MODEL = "openrouter/auto";

/** Pick the model a non-technical user most likely wants from a local server. */
export async function detectLocalModels(
  discover: typeof discoverModels = discoverModels
): Promise<LocalFound[]> {
  const found: LocalFound[] = [];
  for (const provider of ["lm-studio", "ollama"] as const) {
    const baseUrl = PROVIDERS[provider].defaultBaseUrl as string;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const models = await discover({ provider, apiKey: "", baseUrl }, controller.signal);
      clearTimeout(timer);
      const usable = models.find((m) => m.capabilities.agent || m.capabilities.chat);
      if (usable) found.push({ provider, baseUrl, model: usable.id });
    } catch {
      // Not running: that is the normal case.
    }
  }
  return found;
}

function Card({
  title,
  body,
  children
}: {
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.25}>
        <Typography variant="subtitle1">{title}</Typography>
        <Typography variant="body2" color="text.secondary">
          {body}
        </Typography>
        {children}
      </Stack>
    </Paper>
  );
}

export function SimpleConnect({
  onConnect,
  state,
  message
}: {
  onConnect: (config: ProviderConfig) => Promise<void>;
  state: "idle" | "testing" | "success" | "error";
  message: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [local, setLocal] = useState<LocalFound[] | null>(null);

  const scan = async () => {
    setLocal(null);
    setLocal(await detectLocalModels());
  };

  useEffect(() => {
    void scan();
  }, []);

  const run = async (task: () => Promise<ProviderConfig>) => {
    setBusy(true);
    setError("");
    try {
      await onConnect(await task());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect.");
    } finally {
      setBusy(false);
    }
  };

  const working = busy || state === "testing";

  return (
    <Stack spacing={1.5}>
      <Box>
        <Typography variant="h6">Connect your AI</Typography>
        <Typography variant="body2" color="text.secondary">
          Pick the easiest option for you. You can change it any time.
        </Typography>
      </Box>

      <Card
        title="Connect with OpenRouter (recommended)"
        body="Sign in once and use Claude, GPT, Gemini and many other models. You pay only for what you use, and there is no key to copy."
      >
        <Button
          variant="contained"
          disabled={working}
          onClick={() =>
            void run(async () => ({
              provider: "openrouter",
              apiKey: await connectWithOpenRouter(),
              model: OPENROUTER_DEFAULT_MODEL
            }))
          }
        >
          {working ? "Connecting…" : "Connect"}
        </Button>
      </Card>

      <Card
        title="ChatGPT"
        body="Sign in with your ChatGPT account and use your plan. This needs OpenAI's approval for BrowserHarness, which is not in place yet."
      >
        <Button variant="outlined" disabled>
          Coming soon
        </Button>
      </Card>

      <Card
        title="A model on this computer"
        body="Free and private. Works with LM Studio or Ollama when their local server is running."
      >
        {local === null && (
          <Stack direction="row" spacing={1} alignItems="center">
            <CircularProgress size={16} />
            <Typography variant="body2">Looking for local models…</Typography>
          </Stack>
        )}
        {local?.map((found) => (
          <Button
            key={found.provider}
            variant="contained"
            disabled={working}
            onClick={() =>
              void run(async () => ({
                provider: found.provider,
                apiKey: "",
                model: found.model,
                baseUrl: found.baseUrl
              }))
            }
          >
            Connect {PROVIDERS[found.provider].label.replace(" (local)", "")} ({found.model})
          </Button>
        ))}
        {local && local.length === 0 && (
          <Typography variant="body2">
            No local model found. Open LM Studio (Developer tab, start server) or run Ollama, then check again.
          </Typography>
        )}
        {local !== null && (
          <Button size="small" onClick={() => void scan()} disabled={working}>
            Check again
          </Button>
        )}
      </Card>

      {error && <Alert severity="error">{error}</Alert>}
      {state === "success" && <Alert severity="success">{message}</Alert>}
      {state === "error" && !error && <Alert severity="error">{message}</Alert>}
      {state === "testing" && (
        <Alert severity="info" icon={<CircularProgress size={18} />}>
          {message}
        </Alert>
      )}
    </Stack>
  );
}
