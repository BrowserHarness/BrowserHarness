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

const KEY = "browsercrew.providerConfig";

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

export async function loadProviderConfig(): Promise<ProviderConfig | null> {
  const value = await chrome.storage.local.get(KEY);
  return (value[KEY] as ProviderConfig | undefined) ?? null;
}

export async function saveProviderConfig(config: ProviderConfig): Promise<void> {
  await chrome.storage.local.set({ [KEY]: config });
}
