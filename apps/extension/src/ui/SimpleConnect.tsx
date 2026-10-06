import { useEffect, useState, type ReactNode } from "react";
import {
  Autocomplete,
  Box,
  Button,
  CircularProgress,
  Stack,
  TextField,
  Typography
} from "@mui/material";
import { MoreDetails, Note, RecommendedBadge, SettingsCard, StatusPill, Steps } from "./kit";
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
    <Stack spacing={1.25}>
      <Autocomplete
        options={models}
        value={choice}
        onChange={(_, value) => setChoice(value)}
        getOptionLabel={(option) => option.id}
        isOptionEqualToValue={(a, b) => a.id === b.id}
        renderInput={(params) => (
          <TextField
            {...params}
            label={label}
            placeholder={models.length > 8 ? "Type to search, for example “claude” or “gpt”" : "Choose one"}
            helperText={`${models.length} to choose from`}
          />
        )}
        noOptionsText="Nothing matches. Try fewer letters."
      />
      <Box>
        <Button variant="contained" size="large" disabled={disabled || !choice} onClick={() => choice && onUse(choice.id)}>
          Use this model
        </Button>
      </Box>
    </Stack>
  );
}

function Waiting({ children }: { children: ReactNode }) {
  return (
    <Stack direction="row" spacing={1} alignItems="center" role="status">
      <CircularProgress size={16} />
      <Typography variant="body2">{children}</Typography>
    </Stack>
  );
}

/** Shows how the last check went, in the colours of the copy rulebook. */
export function TestResult({ state, message }: { state: "idle" | "testing" | "success" | "error"; message: string }) {
  if (state === "testing") return <Waiting>{message}</Waiting>;
  if (state === "success") return <Note kind={/can only chat/.test(message) ? "warning" : "success"}>{message}</Note>;
  if (state === "error") return <Note kind="danger">{message}</Note>;
  return null;
}

const appName = (provider: LocalProvider) => PROVIDERS[provider].label.replace(" (local)", "");

/** The three easy ways to connect an AI. */
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
  const [lastUsed, setLastUsed] = useState<"openrouter" | "local" | null>(null);

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
      setError(err instanceof Error ? `Could not load the list of models: ${err.message}` : "Could not load the list of models.");
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
      setError(err instanceof Error ? err.message : "Could not connect. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const working = busy || state === "testing";
  const resultFor = (where: "openrouter" | "local") =>
    lastUsed === where ? (
      <>
        {error && <Note kind="danger">{error}</Note>}
        <TestResult state={state} message={message} />
      </>
    ) : null;

  return (
    <Stack spacing={2.5}>
      <Box>
        <Typography variant="h6" component="h2">
          Connect your AI
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Pick one of these. You only need one. After you choose a model, BrowserHarness checks that it really works
          before saving it.
        </Typography>
      </Box>

      <SettingsCard
        title="OpenRouter (recommended)"
        action={<RecommendedBadge label="Easiest" />}
        intro="One sign-in gives you hundreds of AIs, like Claude, GPT and Gemini. You pay OpenRouter only for what you use. There is no key to copy."
      >
        {!openRouter ? (
          <>
            <Steps
              steps={[
                <>Press Connect. A small OpenRouter window opens.</>,
                <>Sign in (or make a free account) and press Authorize. Add a little credit there if it asks.</>,
                <>Come back here and pick an AI from the list.</>
              ]}
            />
            <Box>
              <Button
                variant="contained"
                size="large"
                disabled={working}
                onClick={() => {
                  setLastUsed("openrouter");
                  void run(async () => {
                    const account = makeAccount("openrouter", await connectWithOpenRouter());
                    await saveAccount(account);
                    setOpenRouter(account);
                    await loadOpenRouterModels(account);
                  });
                }}
              >
                {working && lastUsed === "openrouter" ? "Connecting…" : "Connect"}
              </Button>
            </Box>
          </>
        ) : openRouterModels === null ? (
          <Waiting>Loading the list of AIs from OpenRouter…</Waiting>
        ) : (
          <>
            <StatusPill state="good">Your OpenRouter account is connected</StatusPill>
            <ModelChooser
              label="OpenRouter model"
              models={openRouterModels}
              disabled={working}
              onUse={(model) => {
                setLastUsed("openrouter");
                void run(() => onConnect({ provider: "openrouter", apiKey: openRouter.apiKey, model }));
              }}
            />
            <Note kind="tip" title="Not sure which one to pick?">
              Choose a recent, well-known model from a big company, for example a newer Claude, GPT or Gemini. Bigger
              models handle websites better. Cheaper “mini” or “flash” models are fine for simple tasks.
            </Note>
          </>
        )}
        {resultFor("openrouter")}
      </SettingsCard>

      <SettingsCard
        title="ChatGPT"
        intro="Sign in with your ChatGPT account and use your plan. This needs OpenAI's approval for BrowserHarness, which we are still waiting for."
      >
        <Box>
          <Button variant="outlined" disabled>
            Coming soon
          </Button>
        </Box>
      </SettingsCard>

      <SettingsCard
        title="A free AI on this computer"
        intro="Free and private: your requests never leave this computer. You need the LM Studio or Ollama app with a model downloaded, and a fairly powerful computer."
      >
        {local === null && <Waiting>Looking for LM Studio and Ollama on this computer…</Waiting>}
        {local?.map((server) => (
          <Stack key={server.baseUrl} spacing={1.25}>
            <StatusPill state={server.models.length ? "good" : "waiting"}>
              {appName(server.provider)} found at {server.baseUrl.replace(/\/v1$/, "")}
              {` (${server.models.length} model${server.models.length === 1 ? "" : "s"})`}
            </StatusPill>
            {server.models.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No model is loaded yet. Load one in {appName(server.provider)}, then press Look again.
              </Typography>
            ) : (
              <ModelChooser
                label={`${appName(server.provider)} model`}
                models={server.models}
                disabled={working}
                onUse={(model) => {
                  setLastUsed("local");
                  void run(() => onConnect({ provider: server.provider, apiKey: "", model, baseUrl: server.baseUrl }));
                }}
              />
            )}
          </Stack>
        ))}
        {local && local.length === 0 && (
          <Steps
            steps={[
              <>Install LM Studio (lmstudio.ai) or Ollama (ollama.com) and download a model in it.</>,
              <>
                In LM Studio, open the <strong>Developer</strong> tab and press <strong>Start Server</strong>. Ollama
                starts on its own.
              </>,
              <>Press Look again below.</>
            ]}
          />
        )}
        {local !== null && (
          <MoreDetails summary="My AI app shows a different address">
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ xs: "stretch", sm: "flex-start" }}>
              <TextField
                size="small"
                label="Server address (optional)"
                placeholder="http://127.0.0.1:1234"
                helperText="Copy it from your AI app, for example http://127.0.0.1:1234"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                sx={{ flex: 1 }}
              />
            </Stack>
          </MoreDetails>
        )}
        {local !== null && (
          <Box>
            <Button variant="outlined" onClick={() => {
                setLastUsed("local");
                void run(() => scan(address.trim() || undefined));
              }}
              disabled={working}
            >
              Look again
            </Button>
          </Box>
        )}
        {resultFor("local")}
      </SettingsCard>
    </Stack>
  );
}
