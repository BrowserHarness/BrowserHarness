export type McpServerTrustMode =
  | "blocked"
  | "ask-all"
  | "allow-read-only";

export interface McpServerTrustPolicy {
  server_id: string;
  mode: McpServerTrustMode;
  updated_at: string;
}

const KEY = "browsercrew.mcpServerTrust.v1";

function validMode(value: unknown): value is McpServerTrustMode {
  return (
    value === "blocked" ||
    value === "ask-all" ||
    value === "allow-read-only"
  );
}

async function loadAll(): Promise<
  Record<string, McpServerTrustPolicy>
> {
  const stored = await chrome.storage.local.get(KEY);
  const raw =
    stored[KEY] &&
    typeof stored[KEY] === "object" &&
    !Array.isArray(stored[KEY])
      ? (stored[KEY] as Record<string, unknown>)
      : {};

  const result: Record<string, McpServerTrustPolicy> = {};
  for (const [serverId, value] of Object.entries(raw)) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      continue;
    }
    const policy = value as Partial<McpServerTrustPolicy>;
    if (!validMode(policy.mode)) continue;

    result[serverId] = {
      server_id: serverId,
      mode: policy.mode,
      updated_at:
        typeof policy.updated_at === "string"
          ? policy.updated_at
          : new Date(0).toISOString()
    };
  }

  return result;
}

export async function getMcpServerTrustMode(
  serverId: string
): Promise<McpServerTrustMode> {
  const id = serverId.trim();
  if (!id) return "allow-read-only";
  const all = await loadAll();
  return all[id]?.mode || "allow-read-only";
}

export async function listMcpServerTrustPolicies(): Promise<
  McpServerTrustPolicy[]
> {
  return Object.values(await loadAll()).sort((left, right) =>
    left.server_id.localeCompare(right.server_id)
  );
}

export async function setMcpServerTrustMode(
  serverId: string,
  mode: McpServerTrustMode
): Promise<McpServerTrustPolicy> {
  const id = serverId.trim();
  if (!id) {
    throw new Error("MCP server id is required");
  }

  const all = await loadAll();
  const policy: McpServerTrustPolicy = {
    server_id: id,
    mode,
    updated_at: new Date().toISOString()
  };
  all[id] = policy;
  await chrome.storage.local.set({ [KEY]: all });
  return policy;
}

export const MCP_SERVER_TRUST_KEY = KEY;
