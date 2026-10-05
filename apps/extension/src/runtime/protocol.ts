import type { RecordedWorkflowStep } from "./workflows";

export type ToolName =
  | "observe_page"
  | "read_page"
  | "extract_table"
  | "skills"
  | "ax_snapshot"
  | "find"
  | "evaluate"
  | "site_skill"
  | "memory"
  | "mcp"
  | "agent"
  | "select_option"
  | "hover"
  | "drag"
  | "trusted_click"
  | "trusted_type"
  | "trusted_key"
  | "send_keys"
  | "await_user_action"
  | "dialog"
  | "network"
  | "upload"
  | "save_pdf"
  | "cdp"
  | "navigate"
  | "back"
  | "reload"
  | "click"
  | "type"
  | "press_key"
  | "scroll"
  | "wait"
  | "open_tab"
  | "find_tab"
  | "list_tabs"
  | "switch_tab"
  | "close_tab"
  | "close_session"
  | "screenshot";

export interface InteractiveElement {
  element_id: string;
  semantic_ref?: string;
  tag: string;
  role: string;
  accessible_name: string;
  type?: string;
  visible: boolean;
  /** false when the element is outside the visible part of the window. */
  in_viewport?: boolean;
  /** Set for elements inside a same-origin iframe or a shadow root. */
  inside?: "frame" | "shadow";
  disabled: boolean;
  requires_approval?: boolean;
  approval_reason?: string;
  enter_requires_approval?: boolean;
}

export interface PageObservation {
  tab_id: number;
  url: string;
  title: string;
  visible_text: string;
  snapshot?: string;
  elements: InteractiveElement[];
  adapter?: "google-docs" | "generic-web";
}

export type BrowserToolRequest = {
  type: "BROWSER_TOOL";
  tool: ToolName;
  input?: Record<string, unknown>;
  session_id?: string;
  session_title?: string;
  approval_granted?: boolean;
};

export type WatchRequest =
  | { type: "WATCH_STATUS" }
  | { type: "WATCH_START"; tab_id?: number }
  | { type: "WATCH_STOP" }
  | {
      type: "WATCH_CAPTURE_STEP";
      step: RecordedWorkflowStep;
    }
  | {
      type: "WATCH_REPLAY_STEP";
      tab_id?: number;
      step: RecordedWorkflowStep;
    };

export type BridgeLlmRequest = {
  type: "BRIDGE_LLM";
  action: "status" | "complete";
  adapter: "claude_cli" | "codex_cli";
  model?: string;
  system?: string;
  prompt?: string;
  timeout_ms?: number;
};

export type ExtensionRequest =
  | { type: "GET_CURRENT_TAB" }
  | BridgeLlmRequest
  | BrowserToolRequest
  | WatchRequest;

export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: string;
  };
}
