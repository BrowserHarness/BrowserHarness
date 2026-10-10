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
  /** Error code; scope denials end the worker, a missing own tab does not. */
  code?: string;
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

/** What an acting helper may do, only in tabs it opened itself. */
const ACTING_TOOLS = new Set<ToolName>([
  "click",
  "type",
  "press_key",
  "select_option",
  "hover",
  "drag",
  "trusted_click",
  "trusted_type",
  "trusted_key",
  "send_keys",
  "dialog",
  "extract_table"
]);

export type WorkerMode = "read" | "act";

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
    // a learned API read: the run itself refuses anything else (api_read_only)
    if (action === "run") return { allowed: true };
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

/**
 * An acting helper does one part of a bigger task in its own background tab:
 * it may click and type there, never in the person's tabs, and it still
 * cannot run JavaScript, upload files, use raw CDP or change Skills.
 */
export function actingWorkerToolPolicy(
  tool: ToolName,
  input: Record<string, unknown>,
  state: ReadOnlyWorkerToolState
): WorkerToolPolicyResult {
  if (ACTING_TOOLS.has(tool) || tool === "switch_tab") {
    const tabId = requestedTabId(input);
    const allowed =
      tabId !== undefined
        ? state.owned_tab_ids.has(tabId)
        : tool !== "switch_tab" && state.current_owned_tab_id !== undefined;
    return allowed
      ? { allowed: true }
      : {
          allowed: false,
          code: "HELPER_NEEDS_OWN_TAB",
          reason: "Helpers act only in tabs they opened. Open your own tab with open_tab first."
        };
  }
  const readOnly = readOnlyWorkerToolPolicy(tool, input, state);
  return readOnly.allowed
    ? readOnly
    : { allowed: false, reason: (readOnly.reason || "").replace(/Read-only workers?/g, "Helpers") || `Tool ${tool} is outside a helper's scope.` };
}

export function workerToolPolicy(
  mode: WorkerMode,
  tool: ToolName,
  input: Record<string, unknown>,
  state: ReadOnlyWorkerToolState
): WorkerToolPolicyResult {
  return mode === "act" ? actingWorkerToolPolicy(tool, input, state) : readOnlyWorkerToolPolicy(tool, input, state);
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
  execution: BrowserToolExecution | undefined,
  state: ReadOnlyWorkerToolState,
  baseTool: <R = unknown>(
    tool: ToolName,
    input?: Record<string, unknown>,
    execution?: BrowserToolExecution
  ) => Promise<ToolResult<R>>,
  mode: WorkerMode = "read"
): Promise<ToolResult<T>> {
  const policy = workerToolPolicy(
    mode,
    tool,
    input,
    state
  );
  if (!policy.allowed) {
    return {
      ok: false,
      error: {
        code: policy.code || "SUBAGENT_SCOPE_DENIED",
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
      : tool === "site_skill" && input.action === "run"
        ? // workers may run only learned API reads: no page, no form, no write
          { ...input, api_read_only: true }
        : input;

  // Only an acting helper's own approved steps carry the approval through.
  const result = await baseTool<T>(
    tool,
    safeInput,
    mode === "act" ? execution : undefined
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
    (OWNED_TAB_CONTEXT_TOOLS.has(tool) || (mode === "act" && (ACTING_TOOLS.has(tool) || tool === "switch_tab")))
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
