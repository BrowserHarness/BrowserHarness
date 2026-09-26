import {
  PROVIDERS,
  providerBaseUrl,
  type ProviderConfig
} from "../settings/provider-store";

export interface DiscoveredModel {
  id: string;
  ownedBy?: string;
}

export async function discoverModels(
  config: Pick<ProviderConfig, "provider" | "apiKey" | "baseUrl">,
  signal?: AbortSignal
): Promise<DiscoveredModel[]> {
  const definition = PROVIDERS[config.provider];
  if (definition.modelDiscovery !== "openai-models") {
    return [];
  }

  const baseUrl = providerBaseUrl(config.provider, config.baseUrl);
  if (!baseUrl) {
    throw new Error("Base URL is required before loading models.");
  }
  if (!config.apiKey.trim()) {
    throw new Error("API key is required before loading models.");
  }

  const response = await fetch(`${baseUrl}/models`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.apiKey.trim()}`,
      Accept: "application/json"
    },
    signal
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Could not load models (${response.status})${detail ? `: ${detail.slice(0, 160)}` : ""}`
    );
  }

  const json = await response.json();
  const rows = Array.isArray(json?.data) ? json.data : [];

  const models = rows
    .filter((row: unknown): row is { id: string; owned_by?: string } => {
      return Boolean(
        row &&
          typeof row === "object" &&
          typeof (row as { id?: unknown }).id === "string"
      );
    })
    .map((row) => ({
      id: row.id,
      ownedBy: typeof row.owned_by === "string" ? row.owned_by : undefined
    }));

  return [...new Map(models.map((model) => [model.id, model])).values()].sort(
    (a, b) => a.id.localeCompare(b.id)
  );
}
