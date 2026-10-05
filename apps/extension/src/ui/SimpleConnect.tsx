import { useEffect, useState } from "react";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  CircularProgress,
  Paper,
  Stack,
  TextField,
  Typography
} from "@mui/material";
import {
  PROVIDERS,
  type ProviderConfig,
  type ProviderId
} from "../settings/provider-store";
import { discoverModels } from "../settings/model-catalog";
import { connectWithOpenRouter } from "../settings/openrouter-oauth";
import {
  listAccountModels,
  loadAccounts,
  makeAccount,
  saveAccount,
  type AccountModel,
  type ProviderAccount
} from "../settings/account-store";

type LocalProvider = Extract<ProviderId, "lm-studio" | "ollama">;

export interface LocalServer {
  provider: LocalProvider;
  baseUrl: string;
  models: AccountModel[];
}

const LOCAL_PORTS: Record<LocalProvider, number> = {
  "lm-studio": 1234,
  ollama: 11434
};

/**
 * Turn what LM Studio or Ollama shows ("http://127.0.0.1:1234") into the
 * OpenAI-compatible base URL BrowserHarness calls ("http://127.0.0.1:1234/v1").
 */
export function normalizeLocalAddress(value: string): string {
  const trimmed = value.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(withScheme);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path || "/v1";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function probe(
  provider: ProviderId,
  baseUrl: string,
  discover: typeof discoverModels
): Promise<AccountModel[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    return await listAccountModels(makeAccount(provider, "", baseUrl), {
      discover,
      saved: [],
      signal: controller.signal
    });
  } catch {
    return null; // Not running: that is the normal case.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Find LM Studio and Ollama on this computer and list every model they have
 * loaded. Tries 127.0.0.1 (what LM Studio shows) and localhost.
 */
export async function detectLocalModels(
  discover: typeof discoverModels = discoverModels,
  extraAddress?: string
): Promise<LocalServer[]> {
  const found: LocalServer[] = [];
  for (const provider of ["lm-studio", "ollama"] as const) {
    const port = LOCAL_PORTS[provider];
    for (const host of ["127.0.0.1", "localhost"]) {
      const baseUrl = `http://${host}:${port}/v1`;
      const models = await probe(provider, baseUrl, discover);
      if (models) {
        found.push({ provider, baseUrl, models });
        break;
      }
    }
  }
  if (extraAddress) {
    const baseUrl = normalizeLocalAddress(extraAddress);
    if (!found.some((server) => server.baseUrl === baseUrl)) {
      const models = await probe("lm-studio", baseUrl, discover);
      if (models) found.push({ provider: "lm-studio", baseUrl, models });
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

/** Searchable list of every model a service offers; nothing is preselected. */
export function ModelChooser({
  label,
  models,
  disabled,
  onUse
}: {
  label: string;
  models: AccountModel[];
  disabled: boolean;
  onUse: (model: string) => void;
}) {
  const [choice, setChoice] = useState<AccountModel | null>(null);
  return (
    <Stack spacing={1}>
      <Autocomplete
        size="small"
        options={models}
        value={choice}
        onChange={(_, value) => setChoice(value)}
        getOptionLabel={(option) => option.id}
        isOptionEqualToValue={(a, b) => a.id === b.id}
        renderInput={(params) => (
          <TextField
            {...params}
            label={label}
            placeholder={models.length > 8 ? "Type to search" : undefined}
          />
        )}
        noOptionsText="No matching model"
      />
      <Button
        variant="contained"
        disabled={disabled || !choice}
        onClick={() => choice && onUse(choice.id)}
      >
        Use this model
      </Button>
    </Stack>
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
  const [local, setLocal] = useState<LocalServer[] | null>(null);
  const [address, setAddress] = useState("");
  const [openRouter, setOpenRouter] = useState<ProviderAccount | null>(null);
  const [openRouterModels, setOpenRouterModels] = useState<AccountModel[] | null>(null);

  const scan = async (extra?: string) => {
    setLocal(null);
    setLocal(await detectLocalModels(discoverModels, extra));
  };

  const loadOpenRouterModels = async (account: ProviderAccount) => {
    setOpenRouterModels(null);
    try {
      setOpenRouterModels(await listAccountModels(account));
    } catch (err) {
      setOpenRouterModels([]);
      setError(err instanceof Error ? err.message : "Could not load OpenRouter models.");
    }
  };

  useEffect(() => {
    void scan();
    void loadAccounts().then((accounts) => {
      const saved = accounts.find((item) => item.provider === "openrouter" && item.apiKey);
      if (saved) {
        setOpenRouter(saved);
        void loadOpenRouterModels(saved);
      }
    });
  }, []);

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await task();
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
          Connect a service once, then pick any of its models here or from the model menu at the top of the chat.
        </Typography>
      </Box>

      <Card
        title="OpenRouter (recommended)"
        body="Sign in once and use Claude, GPT, Gemini, Qwen, DeepSeek and hundreds of other models. You pay only for what you use, and there is no key to copy."
      >
        {!openRouter ? (
          <Button
            variant="contained"
            disabled={working}
            onClick={() =>
              void run(async () => {
                const account = makeAccount("openrouter", await connectWithOpenRouter());
                await saveAccount(account);
                setOpenRouter(account);
                await loadOpenRouterModels(account);
              })
            }
          >
            {working ? "Connecting…" : "Connect"}
          </Button>
        ) : openRouterModels === null ? (
          <Stack direction="row" spacing={1} alignItems="center">
            <CircularProgress size={16} />
            <Typography variant="body2">Loading OpenRouter models…</Typography>
          </Stack>
        ) : (
          <>
            <Typography variant="body2">
              Connected. Choose a model ({openRouterModels.length} available):
            </Typography>
            <ModelChooser
              label="OpenRouter model"
              models={openRouterModels}
              disabled={working}
              onUse={(model) =>
                void run(() =>
                  onConnect({ provider: "openrouter", apiKey: openRouter.apiKey, model })
                )
              }
            />
          </>
        )}
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
        body="Free and private. Works with LM Studio or Ollama when their local server is running. Every model you have loaded is listed."
      >
        {local === null && (
          <Stack direction="row" spacing={1} alignItems="center">
            <CircularProgress size={16} />
            <Typography variant="body2">Looking for local models…</Typography>
          </Stack>
        )}
        {local?.map((server) => (
          <Stack key={server.baseUrl} spacing={1}>
            <Typography variant="body2">
              {PROVIDERS[server.provider].label.replace(" (local)", "")} found at {server.baseUrl.replace(/\/v1$/, "")}
              {` (${server.models.length} model${server.models.length === 1 ? "" : "s"})`}
            </Typography>
            {server.models.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No model is loaded. Load one in {PROVIDERS[server.provider].label.replace(" (local)", "")}, then check again.
              </Typography>
            ) : (
              <ModelChooser
                label={`${PROVIDERS[server.provider].label.replace(" (local)", "")} model`}
                models={server.models}
                disabled={working}
                onUse={(model) =>
                  void run(() =>
                    onConnect({
                      provider: server.provider,
                      apiKey: "",
                      model,
                      baseUrl: server.baseUrl
                    })
                  )
                }
              />
            )}
          </Stack>
        ))}
        {local && local.length === 0 && (
          <Typography variant="body2">
            No local model found. In LM Studio open the Developer tab and start the server, or run Ollama, then check again.
          </Typography>
        )}
        {local !== null && (
          <Stack direction="row" spacing={1} alignItems="flex-start">
            <TextField
              size="small"
              label="Server address (optional)"
              placeholder="http://127.0.0.1:1234"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              sx={{ flex: 1 }}
            />
            <Button
              size="small"
              onClick={() => void run(() => scan(address.trim() || undefined))}
              disabled={working}
              sx={{ mt: 0.5 }}
            >
              Check again
            </Button>
          </Stack>
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
