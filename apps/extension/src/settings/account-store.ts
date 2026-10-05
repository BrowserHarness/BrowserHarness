import {
  PROVIDERS,
  createConnection,
  isSubscriptionProvider,
  loadConnections,
  loadRoutingConfig,
  providerBaseUrl,
  removeConnection,
  saveConnection,
  saveRoutingConfig,
  type ProviderConnection,
  type ProviderId
} from "./provider-store";
import { discoverModels, type DiscoveredModel } from "./model-catalog";

/**
 * An account is a service the user has connected once (an OpenRouter sign-in,
 * an API key, LM Studio on this computer, a subscription). Every model that
 * account offers can then be picked from the chat model menu; nothing about
 * which model to use is decided for the user.
 */
export interface ProviderAccount {
  id: string;
  provider: ProviderId;
  apiKey: string;
  baseUrl?: string;
}

export interface AccountModel {
  id: string;
  /** Short hint shown next to the name, e.g. "vision" or "chat". */
  kind: string;
}

const ACCOUNTS_KEY = "browserharness.providerAccounts";

/** Models a subscription CLI accepts: the vendor's own aliases. */
export const SUBSCRIPTION_MODELS: Partial<Record<ProviderId, string[]>> = {
  "claude-subscription": ["default", "sonnet", "opus", "haiku"],
  "chatgpt-subscription": ["default"]
};

export function accountIdFor(provider: ProviderId, baseUrl?: string): string {
  return `${provider}::${providerBaseUrl(provider, baseUrl) || "default"}`;
}

export function accountLabel(account: Pick<ProviderAccount, "provider" | "baseUrl">): string {
  const label = PROVIDERS[account.provider].label.replace(" (local)", "");
  if (account.provider === "openai-compatible" && account.baseUrl) {
    try {
      return `${label} · ${new URL(account.baseUrl).host}`;
    } catch {
      return label;
    }
  }
  return label;
}

export function makeAccount(
  provider: ProviderId,
  apiKey: string,
  baseUrl?: string
): ProviderAccount {
  const cleanBase = baseUrl ? baseUrl.trim().replace(/\/$/, "") : undefined;
  return {
    id: accountIdFor(provider, cleanBase),
    provider,
    apiKey: apiKey.trim(),
    ...(cleanBase ? { baseUrl: cleanBase } : {})
  };
}

function isAccount(value: unknown): value is ProviderAccount {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.provider === "string" &&
    row.provider in PROVIDERS &&
    typeof row.apiKey === "string"
  );
}

/** Saved accounts, plus any account implied by an older saved model. */
export async function loadAccounts(): Promise<ProviderAccount[]> {
  const [stored, connections] = await Promise.all([
    chrome.storage.local.get(ACCOUNTS_KEY),
    loadConnections()
  ]);
  const rows = Array.isArray(stored[ACCOUNTS_KEY])
    ? (stored[ACCOUNTS_KEY] as unknown[]).filter(isAccount)
    : [];
  const byId = new Map<string, ProviderAccount>();
  for (const row of rows) byId.set(row.id, row);
  for (const connection of connections) {
    const account = makeAccount(
      connection.provider,
      connection.apiKey || "",
      connection.baseUrl
    );
    if (!byId.has(account.id)) byId.set(account.id, account);
  }
  return [...byId.values()];
}

export async function saveAccount(account: ProviderAccount): Promise<void> {
  const stored = await chrome.storage.local.get(ACCOUNTS_KEY);
  const rows = Array.isArray(stored[ACCOUNTS_KEY])
    ? (stored[ACCOUNTS_KEY] as unknown[]).filter(isAccount)
    : [];
  await chrome.storage.local.set({
    [ACCOUNTS_KEY]: [account, ...rows.filter((row) => row.id !== account.id)]
  });
}

function usableForChat(model: DiscoveredModel): boolean {
  const c = model.capabilities;
  return c.chat || c.agent || c.vision || c.unknown;
}

/**
 * Every chat model the account offers, as the service reports it. Models the
 * service cannot list (Anthropic keys) fall back to the ones already saved.
 */
export async function listAccountModels(
  account: ProviderAccount,
  options: {
    discover?: typeof discoverModels;
    saved?: ProviderConnection[];
    signal?: AbortSignal;
  } = {}
): Promise<AccountModel[]> {
  const subscription = SUBSCRIPTION_MODELS[account.provider];
  if (isSubscriptionProvider(account.provider) && subscription) {
    return subscription.map((id) => ({ id, kind: "subscription" }));
  }
  const saved = (options.saved || (await loadConnections()))
    .filter(
      (connection) =>
        accountIdFor(connection.provider, connection.baseUrl) === account.id
    )
    .map((connection) => ({ id: connection.model, kind: "saved" }));
  if (PROVIDERS[account.provider].modelDiscovery !== "openai-models") {
    return saved;
  }
  const discovered = await (options.discover || discoverModels)(
    {
      provider: account.provider,
      apiKey: account.apiKey,
      baseUrl: account.baseUrl
    },
    options.signal
  );
  return discovered
    .filter(usableForChat)
    .map((model) => ({ id: model.id, kind: model.primaryCapability }));
}

/**
 * Make `model` from `account` the one the chat uses. Keeps what is already
 * known about that model (its checks) when it was used before.
 */
export async function chooseModel(
  account: ProviderAccount,
  model: string
): Promise<ProviderConnection> {
  const connections = await loadConnections();
  const fresh = createConnection({
    provider: account.provider,
    apiKey: account.apiKey,
    model,
    ...(account.baseUrl ? { baseUrl: account.baseUrl } : {})
  });
  const existing = connections.find((item) => item.id === fresh.id);
  const connection = existing
    ? { ...existing, apiKey: account.apiKey || existing.apiKey }
    : fresh;
  await saveConnection(connection);
  const routing = await loadRoutingConfig();
  await saveRoutingConfig({
    ...routing,
    primaryConnectionId: connection.id,
    fallbackConnectionId:
      routing.fallbackConnectionId === connection.id
        ? undefined
        : routing.fallbackConnectionId
  });
  return connection;
}

/** Forget an account and every model saved from it. */
export async function removeAccount(id: string): Promise<void> {
  const stored = await chrome.storage.local.get(ACCOUNTS_KEY);
  const rows = Array.isArray(stored[ACCOUNTS_KEY])
    ? (stored[ACCOUNTS_KEY] as unknown[]).filter(isAccount)
    : [];
  await chrome.storage.local.set({
    [ACCOUNTS_KEY]: rows.filter((row) => row.id !== id)
  });
  const connections = await loadConnections();
  for (const connection of connections) {
    if (accountIdFor(connection.provider, connection.baseUrl) === id) {
      await removeConnection(connection.id);
    }
  }
}
