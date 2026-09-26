import {
  PROVIDERS,
  providerBaseUrl,
  type ProviderConfig
} from "../settings/provider-store";
import {
  classifyModelCapabilities,
  primaryCapabilityLabel,
  type ModelCapabilities,
  type ModelCapability
} from "./model-capabilities";

export interface DiscoveredModel {
  id: string;
  ownedBy?: string;
  capabilities: ModelCapabilities;
  primaryCapability: ModelCapability;
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

  const unique = new Map<string, DiscoveredModel>();
  for (const row of rows.filter(isModelRow)) {
    const capabilities = classifyModelCapabilities(row.id);
    unique.set(row.id, {
      id: row.id,
      ownedBy:
        typeof row.owned_by === "string" ? row.owned_by : undefined,
      capabilities,
      primaryCapability: primaryCapabilityLabel(capabilities)
    });
  }

  return [...unique.values()].sort((a, b) => {
    const rank = (model: DiscoveredModel) => {
      if (model.capabilities.agent) return 0;
      if (model.capabilities.chat) return 1;
      if (model.capabilities.vision) return 2;
      if (model.capabilities.unknown) return 3;
      return 4;
    };
    return rank(a) - rank(b) || a.id.localeCompare(b.id);
  });
}
