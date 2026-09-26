export type ProviderId = "openai" | "anthropic" | "openai-compatible";

export interface ProviderConfig {
  provider: ProviderId;
  apiKey: string;
  model: string;
  baseUrl?: string;
}

const KEY = "browsercrew.providerConfig";

export async function loadProviderConfig(): Promise<ProviderConfig | null> {
  const value = await chrome.storage.local.get(KEY);
  return (value[KEY] as ProviderConfig | undefined) ?? null;
}

export async function saveProviderConfig(config: ProviderConfig): Promise<void> {
  await chrome.storage.local.set({ [KEY]: config });
}
