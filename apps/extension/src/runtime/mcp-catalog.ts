import type { ToolResult } from "./protocol";
import type {
  McpServerTrustMode
} from "../settings/mcp-trust-store";

const MAX_SERVERS = 6;
const MAX_TOOLS_TOTAL = 18;
const MAX_TOOL_DESCRIPTION = 240;

export interface BrowserHarnessMcpCatalogTool {
  server_id: string;
  server_label: string;
  name: string;
  description?: string;
  read_only: boolean;
  requires_approval: boolean;
  trust_mode: McpServerTrustMode;
}

export interface BrowserHarnessMcpCatalog {
  servers_considered: number;
  tools: BrowserHarnessMcpCatalogTool[];
}

type McpRuntimeTool = (
  input: Record<string, unknown>
) => Promise<ToolResult>;

type TrustModeLoader = (
  serverId: string
) => Promise<McpServerTrustMode>;

interface McpServerSummary {
  id: string;
  label: string;
  enabled: boolean;
}

interface McpToolSummary {
  name: string;
  description?: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
}

function tokens(value: string): string[] {
  return [...new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9._:/-]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
  )];
}

function relevance(
  tool: McpToolSummary,
  query: string
): number {
  const haystack = [
    tool.name,
    tool.description || ""
  ]
    .join(" ")
    .toLowerCase();

  const queryText = query.toLowerCase().trim();
  let score =
    queryText && haystack.includes(queryText) ? 100 : 0;

  for (const token of tokens(queryText)) {
    if (tool.name.toLowerCase().includes(token)) {
      score += 10;
    } else if (haystack.includes(token)) {
      score += 4;
    }
  }

  return score;
}

function toolApproval(
  tool: McpToolSummary,
  trustMode: McpServerTrustMode
): {
  read_only: boolean;
  requires_approval: boolean;
} {
  const readOnly =
    tool.annotations?.readOnlyHint === true &&
    tool.annotations?.destructiveHint !== true;

  return {
    read_only: readOnly,
    requires_approval:
      trustMode === "ask-all" || !readOnly
  };
}

export async function discoverMcpCatalog(
  query: string,
  runMcpTool: McpRuntimeTool,
  trustModeLoader: TrustModeLoader
): Promise<BrowserHarnessMcpCatalog> {
  const serverResult = await runMcpTool({
    action: "servers"
  });
  if (!serverResult.ok || !serverResult.data) {
    return {
      servers_considered: 0,
      tools: []
    };
  }

  const rawServers =
    (serverResult.data as { servers?: unknown }).servers;
  const servers = Array.isArray(rawServers)
    ? (rawServers as McpServerSummary[])
        .filter(
          (server) =>
            server &&
            typeof server.id === "string" &&
            typeof server.label === "string" &&
            server.enabled !== false
        )
        .slice(0, MAX_SERVERS)
    : [];

  const discovered: Array<
    BrowserHarnessMcpCatalogTool & { relevance: number }
  > = [];

  for (const server of servers) {
    const trustMode = await trustModeLoader(server.id);
    if (trustMode === "blocked") continue;

    const toolResult = await runMcpTool({
      action: "list_tools",
      server_id: server.id
    });
    if (!toolResult.ok || !toolResult.data) continue;

    const rawTools =
      (toolResult.data as { tools?: unknown }).tools;
    if (!Array.isArray(rawTools)) continue;

    for (const tool of rawTools as McpToolSummary[]) {
      if (!tool || typeof tool.name !== "string") continue;
      const approval = toolApproval(tool, trustMode);
      discovered.push({
        server_id: server.id,
        server_label: server.label,
        name: tool.name,
        ...(typeof tool.description === "string" &&
        tool.description.trim()
          ? {
              description: tool.description
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, MAX_TOOL_DESCRIPTION)
            }
          : {}),
        ...approval,
        trust_mode: trustMode,
        relevance: relevance(tool, query)
      });
    }
  }

  discovered.sort(
    (left, right) =>
      right.relevance - left.relevance ||
      Number(left.requires_approval) -
        Number(right.requires_approval) ||
      left.server_label.localeCompare(right.server_label) ||
      left.name.localeCompare(right.name)
  );

  return {
    servers_considered: servers.length,
    tools: discovered
      .slice(0, MAX_TOOLS_TOTAL)
      .map(({ relevance: _relevance, ...tool }) => tool)
  };
}
