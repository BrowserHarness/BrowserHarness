import type {
  ToolName,
  ToolResult
} from "./protocol";
import type { BrowserToolExecution } from "./browser-engine";

export interface ReadOnlyWorkerToolState {
  owned_tab_ids: Set<number>;
  current_owned_tab_id?: number;
}

export interface WorkerToolPolicyResult {
  allowed: boolean;
  reason?: string;
}

const PASSIVE_TOOLS = new Set<ToolName>([
  "observe_page",
  "read_page",
  "ax_snapshot",
  "find",
  "screenshot",
  "list_tabs",
  "wait"
]);

const OWNED_TAB_CONTEXT_TOOLS = new Set<ToolName>([
  "navigate",
  "back",
  "reload",
  "scroll"
]);

const ALLOWED_MEMORY_ACTIONS = new Set([
  "active",
  "search",
  "list",
  "get",
  "procedures"
]);

const ALLOWED_SITE_SKILL_ACTIONS = new Set([
  "list",
  "get",
  "history",
  "compare"
]);

const ALLOWED_MCP_ACTIONS = new Set([
  "servers",
  "list_tools",
  "call_tool"
]);

function requestedTabId(
  input: Record<string, unknown>
): number | undefined {
  return typeof input.tab_id === "number"
    ? input.tab_id
    : undefined;
}

export function readOnlyWorkerToolPolicy(
  tool: ToolName,
  input: Record<string, unknown>,
  state: ReadOnlyWorkerToolState
): WorkerToolPolicyResult {
  if (PASSIVE_TOOLS.has(tool)) {
    return { allowed: true };
  }

  if (tool === "open_tab") {
    return { allowed: true };
  }

  if (tool === "close_session") {
    return { allowed: true };
  }

  if (tool === "close_tab") {
    const tabId = requestedTabId(input);
    return tabId && state.owned_tab_ids.has(tabId)
      ? { allowed: true }
      : {
          allowed: false,
          reason:
            "Read-only workers may close only tabs they created."
        };
  }

  if (OWNED_TAB_CONTEXT_TOOLS.has(tool)) {
    const tabId = requestedTabId(input);
    const allowed =
      tabId !== undefined
        ? state.owned_tab_ids.has(tabId)
        : state.current_owned_tab_id !== undefined;

    return allowed
      ? { allowed: true }
      : {
          allowed: false,
          reason:
            "Read-only workers must open a background worker-owned tab before navigating or scrolling."
        };
  }

  if (tool === "memory") {
    const action =
      typeof input.action === "string"
        ? input.action
        : "search";
    return ALLOWED_MEMORY_ACTIONS.has(action)
      ? { allowed: true }
      : {
          allowed: false,
          reason:
            `Read-only workers cannot use memory action ${action}.`
        };
  }

  if (tool === "site_skill") {
    const action =
      typeof input.action === "string"
        ? input.action
        : "list";
    return ALLOWED_SITE_SKILL_ACTIONS.has(action)
      ? { allowed: true }
      : {
          allowed: false,
          reason:
            `Read-only workers cannot execute or mutate Site Skills (${action}).`
        };
  }

  if (tool === "mcp") {
    const action =
      typeof input.action === "string"
        ? input.action
        : "servers";
    return ALLOWED_MCP_ACTIONS.has(action)
      ? { allowed: true }
      : {
          allowed: false,
          reason:
            `Read-only workers cannot use MCP action ${action}.`
        };
  }

  return {
    allowed: false,
    reason:
      `Tool ${tool} is outside the read-only worker scope.`
  };
}

function tabIdFromResult(result: ToolResult): number | undefined {
  if (!result.data || typeof result.data !== "object") {
    return undefined;
  }
  const value = (result.data as { tab_id?: unknown }).tab_id;
  return typeof value === "number" ? value : undefined;
}

export async function runReadOnlyWorkerTool<T = unknown>(
  tool: ToolName,
  input: Record<string, unknown>,
  _execution: BrowserToolExecution | undefined,
  state: ReadOnlyWorkerToolState,
  baseTool: <R = unknown>(
    tool: ToolName,
    input?: Record<string, unknown>,
    execution?: BrowserToolExecution
  ) => Promise<ToolResult<R>>
): Promise<ToolResult<T>> {
  const policy = readOnlyWorkerToolPolicy(
    tool,
    input,
    state
  );
  if (!policy.allowed) {
    return {
      ok: false,
      error: {
        code: "SUBAGENT_SCOPE_DENIED",
        message:
          policy.reason ||
          "This tool is outside the read-only worker scope."
      }
    };
  }

  const safeInput =
    tool === "open_tab"
      ? {
          ...input,
          active: false
        }
      : input;

  const result = await baseTool<T>(
    tool,
    safeInput,
    undefined
  );

  if (result.ok && tool === "open_tab") {
    const tabId = tabIdFromResult(result);
    if (tabId !== undefined) {
      state.owned_tab_ids.add(tabId);
      state.current_owned_tab_id = tabId;
    }
  }

  if (result.ok && tool === "close_tab") {
    const tabId = requestedTabId(input);
    if (tabId !== undefined) {
      state.owned_tab_ids.delete(tabId);
      if (state.current_owned_tab_id === tabId) {
        state.current_owned_tab_id = undefined;
      }
    }
  }

  if (
    result.ok &&
    OWNED_TAB_CONTEXT_TOOLS.has(tool)
  ) {
    const tabId =
      requestedTabId(input) ||
      state.current_owned_tab_id;
    if (tabId !== undefined) {
      state.current_owned_tab_id = tabId;
    }
  }

  return result;
}

export function newReadOnlyWorkerToolState(): ReadOnlyWorkerToolState {
  return {
    owned_tab_ids: new Set<number>()
  };
}
