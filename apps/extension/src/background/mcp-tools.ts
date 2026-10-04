import type { ToolResult } from "../runtime/protocol";
import type { ToolExecutionOptions } from "./approval-grant";
import {
  requestBridgeMcp,
  type BridgeRpcResult
} from "./bridge-client";
import {
  getMcpServerTrustMode,
  type McpServerTrustMode
} from "../settings/mcp-trust-store";

export interface ExternalMcpToolMetadata {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

type McpRequester = (
  action: "servers" | "list_tools" | "call_tool",
  args?: Record<string, unknown>,
  approved?: boolean
) => Promise<BridgeRpcResult>;

type TrustModeLoader = (
  serverId: string
) => Promise<McpServerTrustMode>;

export function externalMcpToolRequiresApproval(
  tool: ExternalMcpToolMetadata
): boolean {
  const annotations =
    tool.annotations &&
    typeof tool.annotations === "object"
      ? tool.annotations
      : {};

  return !(
    annotations.readOnlyHint === true &&
    annotations.destructiveHint !== true
  );
}

function bridgeResult(result: BridgeRpcResult): ToolResult {
  return result.ok
    ? { ok: true, data: result.data }
    : {
        ok: false,
        error: {
          code:
            result.error?.code ||
            "MCP_CLIENT_FAILED",
          message:
            result.error?.message ||
            "Outbound MCP request failed",
          ...(result.error?.details
            ? { details: result.error.details }
            : {})
        }
      };
}

function serverId(input: Record<string, unknown>): string {
  return typeof input.server_id === "string"
    ? input.server_id.trim()
    : "";
}

function toolName(input: Record<string, unknown>): string {
  return typeof input.tool === "string"
    ? input.tool.trim()
    : "";
}

function callArguments(
  input: Record<string, unknown>
): Record<string, unknown> | null {
  if (input.arguments === undefined) return {};
  if (
    !input.arguments ||
    typeof input.arguments !== "object" ||
    Array.isArray(input.arguments)
  ) {
    return null;
  }
  return input.arguments as Record<string, unknown>;
}

export async function runExternalMcpTool(
  input: Record<string, unknown>,
  options: ToolExecutionOptions = {},
  requester: McpRequester = requestBridgeMcp,
  trustModeLoader: TrustModeLoader =
    getMcpServerTrustMode
): Promise<ToolResult> {
  const action =
    typeof input.action === "string"
      ? input.action
      : "servers";

  if (action === "servers") {
    return bridgeResult(
      await requester("servers", {})
    );
  }

  if (action === "list_tools") {
    const id = serverId(input);
    if (!id) {
      return {
        ok: false,
        error: {
          code: "MCP_SERVER_ID_REQUIRED",
          message:
            "mcp list_tools requires server_id"
        }
      };
    }
    return bridgeResult(
      await requester("list_tools", {
        server_id: id
      })
    );
  }

  if (action === "call_tool") {
    const id = serverId(input);
    const name = toolName(input);
    const args = callArguments(input);

    if (!id) {
      return {
        ok: false,
        error: {
          code: "MCP_SERVER_ID_REQUIRED",
          message:
            "mcp call_tool requires server_id"
        }
      };
    }
    if (!name) {
      return {
        ok: false,
        error: {
          code: "MCP_TOOL_NAME_REQUIRED",
          message: "mcp call_tool requires tool"
        }
      };
    }
    if (!args) {
      return {
        ok: false,
        error: {
          code: "MCP_TOOL_ARGUMENTS_INVALID",
          message:
            "mcp call_tool arguments must be an object"
        }
      };
    }

    const trustMode = await trustModeLoader(id);

    if (trustMode === "blocked") {
      return {
        ok: false,
        error: {
          code: "MCP_SERVER_BLOCKED",
          message:
            `External MCP server ${id} is blocked by BrowserHarness settings.`
        }
      };
    }

    const listed = await requester("list_tools", {
      server_id: id
    });
    if (!listed.ok) return bridgeResult(listed);

    const data =
      listed.data &&
      typeof listed.data === "object"
        ? (listed.data as {
            tools?: unknown;
          })
        : {};
    const tools = Array.isArray(data.tools)
      ? (data.tools as ExternalMcpToolMetadata[])
      : [];
    const tool = tools.find(
      (candidate) => candidate.name === name
    );

    if (!tool) {
      return {
        ok: false,
        error: {
          code: "MCP_TOOL_NOT_FOUND",
          message:
            `External MCP tool ${id}/${name} was not found in fresh discovery`
        }
      };
    }

    const requiresApproval =
      trustMode === "ask-all" ||
      externalMcpToolRequiresApproval(tool);

    if (
      requiresApproval &&
      options.approvalGranted !== true
    ) {
      return {
        ok: false,
        error: {
          code: "APPROVAL_REQUIRED",
          message:
            trustMode === "ask-all"
              ? `External MCP server ${id} is configured to ask before every tool call. Approve ${name} in BrowserHarness before execution.`
              : `External MCP tool ${id}/${name} is not explicitly read-only. Approve this tool call in BrowserHarness before execution.`
        }
      };
    }

    return bridgeResult(
      await requester(
        "call_tool",
        {
          server_id: id,
          tool: name,
          arguments: args
        },
        options.approvalGranted === true
      )
    );
  }

  return {
    ok: false,
    error: {
      code: "MCP_ACTION_INVALID",
      message:
        "mcp action must be servers, list_tools, or call_tool"
    }
  };
}
