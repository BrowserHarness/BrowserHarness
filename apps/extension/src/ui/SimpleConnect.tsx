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
import { ProblemCard, SuccessBanner, useSaved } from "./feedback";
import { diagnoseAi, noModels, type Problem } from "../help/problems";
import { aiContext, type ConnectFeedback } from "./settings/connect-ai";
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

export function Waiting({ children }: { children: ReactNode }) {
  return (
    <Stack direction="row" spacing={1.25} alignItems="center" role="status" aria-live="polite" sx={{ py: 0.5 }}>
      <CircularProgress size={18} />
      <Typography variant="body2">{children}</Typography>
    </Stack>
  );
}

/** How the last connect attempt went: a tick, or the reason and the fix. */
export function TestResult({ feedback, onRetry }: { feedback: ConnectFeedback; onRetry?: () => void }) {
  if (feedback.state === "testing") return <Waiting>{feedback.message}</Waiting>;
  if (feedback.state === "success" && feedback.problem) {
    return <ProblemCard problem={feedback.problem} severity="warning" heading="Saved for chatting only" />;
  }
  if (feedback.state === "success") return <SuccessBanner title="Connected">{feedback.message}</SuccessBanner>;
  if (feedback.state === "error") {
    return feedback.problem ? (
      <ProblemCard problem={feedback.problem} heading="Couldn't connect" onRetry={onRetry} />
    ) : (
      <ProblemCard problem={diagnoseAi(feedback.message)} heading="Couldn't connect" onRetry={onRetry} />
    );
  }
  return null;
}

const appName = (provider: LocalProvider) => PROVIDERS[provider].label.replace(" (local)", "") as "LM Studio" | "Ollama";

type Where = "openrouter" | "local";

/** The three easy ways to connect an AI. */
export function SimpleConnect({
  onConnect,
  feedback
}: {
  onConnect: (config: ProviderConfig) => Promise<void>;
  feedback: ConnectFeedback;
}) {
  const saved = useSaved();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ where: Where; problem: Problem; retry?: () => void } | null>(null);
  const [local, setLocal] = useState<LocalServer[] | null>(null);
  const [looked, setLooked] = useState(false);
  const [address, setAddress] = useState("");
  const [openRouter, setOpenRouter] = useState<ProviderAccount | null>(null);
  const [openRouterModels, setOpenRouterModels] = useState<AccountModel[] | null>(null);
  const [lastUsed, setLastUsed] = useState<Where | null>(null);
  const [lastTry, setLastTry] = useState<(() => void) | null>(null);

  const scan = async (extra?: string) => {
    setLocal(null);
    const found = await detectLocalModels(discoverModels, extra);
    setLocal(found);
    return found;
  };

  const loadOpenRouterModels = async (account: ProviderAccount) => {
    setOpenRouterModels(null);
    try {
      setOpenRouterModels(await listAccountModels(account));
    } catch (err) {
      setOpenRouterModels([]);
      setProblem({ where: "openrouter", problem: diagnoseAi(err, { service: "OpenRouter" }), retry: () => void loadOpenRouterModels(account) });
    }
  };

  useEffect(() => {
    void scan();
    void loadAccounts().then((accounts) => {
      const savedAccount = accounts.find((item) => item.provider === "openrouter" && item.apiKey);
      if (savedAccount) {
        setOpenRouter(savedAccount);
        void loadOpenRouterModels(savedAccount);
      }
    });
  }, []);

  const run = async (where: Where, task: () => Promise<void>, context?: Parameters<typeof diagnoseAi>[1]) => {
    setLastUsed(where);
    setBusy(true);
    setProblem(null);
    const retry = () => void run(where, task, context);
    setLastTry(() => retry);
    try {
      await task();
    } catch (err) {
      setProblem({ where, problem: diagnoseAi(err, context), retry });
    } finally {
      setBusy(false);
    }
  };

  const connectOpenRouter = () =>
    run(
      "openrouter",
      async () => {
        const account = makeAccount("openrouter", await connectWithOpenRouter());
        await saveAccount(account);
        setOpenRouter(account);
        saved("Signed in to OpenRouter");
        await loadOpenRouterModels(account);
      },
      { service: "OpenRouter" }
    );

  const lookAgain = () =>
    run("local", async () => {
      setLooked(true);
      const found = await scan(address.trim() || undefined);
      if (found.length) saved(`Found ${found.map((server) => appName(server.provider)).join(" and ")}`);
    });

  const working = busy || feedback.state === "testing";
  const resultFor = (where: Where) =>
    lastUsed === where ? (
      <>
        {problem?.where === where && <ProblemCard problem={problem.problem} heading="Couldn't connect" onRetry={problem.retry} />}
        {!problem && <TestResult feedback={feedback} onRetry={lastTry || undefined} />}
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
              <Button variant="contained" size="large" disabled={working} onClick={() => void connectOpenRouter()}>
                {working && lastUsed === "openrouter" ? "Waiting for OpenRouter…" : "Connect"}
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
              onUse={(model) =>
                void run("openrouter", () => onConnect({ provider: "openrouter", apiKey: openRouter.apiKey, model }), { service: "OpenRouter", model })
              }
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
              <ProblemCard problem={noModels({ local: true, app: appName(server.provider) })} severity="warning" onRetry={() => void lookAgain()} retryLabel="Look again" />
            ) : (
              <ModelChooser
                label={`${appName(server.provider)} model`}
                models={server.models}
                disabled={working}
                onUse={(model) =>
                  void run(
                    "local",
                    () => onConnect({ provider: server.provider, apiKey: "", model, baseUrl: server.baseUrl }),
                    aiContext({ provider: server.provider, model })
                  )
                }
              />
            )}
          </Stack>
        ))}
        {local && local.length === 0 && !looked && (
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
        {local && local.length === 0 && looked && (
          <ProblemCard
            problem={diagnoseAi("Failed to fetch", { local: true })}
            heading="Nothing found"
            onRetry={() => void lookAgain()}
            retryLabel="Look again"
          />
        )}
        {local !== null && (
          <MoreDetails summary="My AI app shows a different address">
            <TextField
              size="small"
              fullWidth
              label="Server address (optional)"
              placeholder="http://127.0.0.1:1234"
              helperText="Copy it from your AI app, for example http://127.0.0.1:1234"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
          </MoreDetails>
        )}
        {local !== null && !(local.length === 0 && looked) && (
          <Box>
            <Button variant="outlined" onClick={() => void lookAgain()} disabled={working}>
              Look again
            </Button>
          </Box>
        )}
        {resultFor("local")}
      </SettingsCard>
    </Stack>
  );
}
