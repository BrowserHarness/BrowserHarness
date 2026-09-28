import {
  classifyModelCapabilities,
  type ModelCapabilities
} from "./model-capabilities";

export type ProviderId =
  | "openai"
  | "anthropic"
  | "nvidia"
  | "openai-compatible";

export interface ProviderConfig {
  provider: ProviderId;
  apiKey: string;
  model: string;
  baseUrl?: string;
  validatedAt?: string;
  validatedLatencyMs?: number;
}

export interface CapabilityHealth {
  status: "unknown" | "healthy" | "failed" | "rate-limited" | "unauthorized" | "timeout";
  latencyMs?: number;
  checkedAt?: string;
  message?: string;
}

export interface ProviderConnection extends ProviderConfig {
  id: string;
  label: string;
  capabilities: ModelCapabilities;
  chatHealth: CapabilityHealth;
  agentHealth: CapabilityHealth;
  embeddingHealth: CapabilityHealth;
}

export interface RuntimeRoutingConfig {
  primaryConnectionId?: string;
  fallbackConnectionId?: string;
  embeddingConnectionId?: string;
}

export interface ProviderDefinition {
  id: ProviderId;
  label: string;
  defaultBaseUrl?: string;
  modelDiscovery: "openai-models" | "manual";
}

export const PROVIDERS: Record<ProviderId, ProviderDefinition> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    modelDiscovery: "openai-models"
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    modelDiscovery: "manual"
  },
  nvidia: {
    id: "nvidia",
    label: "NVIDIA",
    defaultBaseUrl: "https://integrate.api.nvidia.com/v1",
    modelDiscovery: "openai-models"
  },
  "openai-compatible": {
    id: "openai-compatible",
    label: "OpenAI-compatible",
    modelDiscovery: "openai-models"
  }
};

const LEGACY_KEY = "browsercrew.providerConfig";
const CONNECTIONS_KEY = "browsercrew.providerConnections";
const ROUTING_KEY = "browsercrew.runtimeRouting";

export function providerBaseUrl(
  provider: ProviderId,
  configuredBaseUrl?: string
): string {
  if (provider === "openai-compatible") {
    return String(configuredBaseUrl || "").replace(/\/$/, "");
  }
  return String(
    configuredBaseUrl || PROVIDERS[provider].defaultBaseUrl || ""
  ).replace(/\/$/, "");
}

export function connectionIdFor(config: Pick<ProviderConfig, "provider" | "model" | "baseUrl">): string {
  return [
    config.provider,
    providerBaseUrl(config.provider, config.baseUrl) || "default",
    config.model
  ].join("::");
}

export function createConnection(
  config: ProviderConfig,
  health?: Partial<
    Pick<
      ProviderConnection,
      "chatHealth" | "agentHealth" | "embeddingHealth"
    >
  >
): ProviderConnection {
  const id = connectionIdFor(config);
  return {
    ...config,
    id,
    label: `${PROVIDERS[config.provider].label} · ${config.model}`,
    capabilities: classifyModelCapabilities(config.model),
    chatHealth: health?.chatHealth || { status: "unknown" },
    agentHealth: health?.agentHealth || { status: "unknown" },
    embeddingHealth:
      health?.embeddingHealth || { status: "unknown" }
  };
}

export async function loadConnections(): Promise<ProviderConnection[]> {
  const stored = await chrome.storage.local.get([CONNECTIONS_KEY, LEGACY_KEY]);
  const connections = stored[CONNECTIONS_KEY];

  if (Array.isArray(connections)) {
    return (connections as ProviderConnection[]).map(
      (connection) => ({
        ...connection,
        capabilities:
          connection.capabilities ||
          classifyModelCapabilities(connection.model),
        chatHealth:
          connection.chatHealth || { status: "unknown" },
        agentHealth:
          connection.agentHealth || { status: "unknown" },
        embeddingHealth:
          connection.embeddingHealth || { status: "unknown" }
      })
    );
  }

  const legacy = stored[LEGACY_KEY] as ProviderConfig | undefined;
  if (legacy?.provider && legacy?.model && legacy?.apiKey) {
    const migrated = [createConnection(legacy)];
    await chrome.storage.local.set({ [CONNECTIONS_KEY]: migrated });
    return migrated;
  }

  return [];
}

export async function saveConnection(connection: ProviderConnection): Promise<void> {
  const current = await loadConnections();
  const next = [
    connection,
    ...current.filter((item) => item.id !== connection.id)
  ];
  await chrome.storage.local.set({ [CONNECTIONS_KEY]: next });
}

export async function removeConnection(id: string): Promise<void> {
  const current = await loadConnections();
  const next = current.filter((item) => item.id !== id);
  const routing = await loadRoutingConfig();
  const updatedRouting: RuntimeRoutingConfig = {
    primaryConnectionId:
      routing.primaryConnectionId === id
        ? undefined
        : routing.primaryConnectionId,
    fallbackConnectionId:
      routing.fallbackConnectionId === id
        ? undefined
        : routing.fallbackConnectionId,
    embeddingConnectionId:
      routing.embeddingConnectionId === id
        ? undefined
        : routing.embeddingConnectionId
  };
  await chrome.storage.local.set({
    [CONNECTIONS_KEY]: next,
    [ROUTING_KEY]: updatedRouting
  });
}

export async function loadRoutingConfig(): Promise<RuntimeRoutingConfig> {
  const stored = await chrome.storage.local.get(ROUTING_KEY);
  return (stored[ROUTING_KEY] as RuntimeRoutingConfig | undefined) || {};
}

export async function saveRoutingConfig(config: RuntimeRoutingConfig): Promise<void> {
  await chrome.storage.local.set({ [ROUTING_KEY]: config });
}

export async function loadActiveConnection(): Promise<ProviderConnection | null> {
  const [connections, routing] = await Promise.all([
    loadConnections(),
    loadRoutingConfig()
  ]);

  return (
    connections.find(
      (item) =>
        item.id === routing.primaryConnectionId &&
        (item.capabilities.chat ||
          item.capabilities.agent ||
          item.capabilities.vision ||
          item.capabilities.unknown)
    ) ||
    connections.find(
      (item) => item.chatHealth.status === "healthy"
    ) ||
    connections.find(
      (item) =>
        item.capabilities.chat ||
        item.capabilities.agent ||
        item.capabilities.vision ||
        item.capabilities.unknown
    ) ||
    null
  );
}

export async function loadFallbackConnection(): Promise<ProviderConnection | null> {
  const [connections, routing] = await Promise.all([
    loadConnections(),
    loadRoutingConfig()
  ]);
  return (
    connections.find(
      (item) =>
        item.id === routing.fallbackConnectionId &&
        (item.capabilities.chat ||
          item.capabilities.agent ||
          item.capabilities.vision ||
          item.capabilities.unknown)
    ) || null
  );
}

export async function loadEmbeddingConnection(): Promise<ProviderConnection | null> {
  const [connections, routing] = await Promise.all([
    loadConnections(),
    loadRoutingConfig()
  ]);

  return (
    connections.find(
      (item) =>
        item.id === routing.embeddingConnectionId &&
        item.capabilities.embedding &&
        item.embeddingHealth.status === "healthy"
    ) ||
    connections.find(
      (item) =>
        item.capabilities.embedding &&
        item.embeddingHealth.status === "healthy"
    ) ||
    null
  );
}

// Compatibility shim while the UI/runtime migrate to the connection registry.
export async function loadProviderConfig(): Promise<ProviderConfig | null> {
  return loadActiveConnection();
}

export async function saveProviderConfig(config: ProviderConfig): Promise<void> {
  await chrome.storage.local.set({ [LEGACY_KEY]: config });
  const connection = createConnection(config, {
    chatHealth:
      config.validatedAt
        ? {
            status: "healthy",
            latencyMs: config.validatedLatencyMs,
            checkedAt: config.validatedAt
          }
        : { status: "unknown" }
  });
  await saveConnection(connection);

  const routing = await loadRoutingConfig();
  if (!routing.primaryConnectionId) {
    await saveRoutingConfig({
      ...routing,
      primaryConnectionId: connection.id
    });
  }
}
