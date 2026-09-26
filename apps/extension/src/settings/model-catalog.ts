import {
  PROVIDERS,
  providerBaseUrl,
  type ProviderConfig
} from "../settings/provider-store";

export interface DiscoveredModel {
  id: string;
  ownedBy?: string;
}

interface ModelRow {
  id: string;
  owned_by?: string;
}

function isModelRow(value: unknown): value is ModelRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string";
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

  const json = (await response.json()) as { data?: unknown };
  const rows: unknown[] = Array.isArray(json.data) ? json.data : [];

  const models: DiscoveredModel[] = rows
    .filter(isModelRow)
    .map((row): DiscoveredModel => ({
      id: row.id,
      ownedBy:
        typeof row.owned_by === "string" ? row.owned_by : undefined
    }));

  const unique = new Map<string, DiscoveredModel>();
  for (const model of models) {
    unique.set(model.id, model);
  }

  return [...unique.values()].sort((a, b) =>
    a.id.localeCompare(b.id)
  );
}
