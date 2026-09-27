import type { RecordedWorkflowStep } from "./workflows";

export type ToolName =
  | "observe_page"
  | "navigate"
  | "click"
  | "type"
  | "press_key"
  | "scroll"
  | "wait"
  | "open_tab"
  | "switch_tab"
  | "close_tab"
  | "screenshot";

export interface InteractiveElement {
  element_id: string;
  tag: string;
  role: string;
  accessible_name: string;
  type?: string;
  visible: boolean;
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
  elements: InteractiveElement[];
  adapter?: "google-docs" | "generic-web";
}

export type BrowserToolRequest = {
  type: "BROWSER_TOOL";
  tool: ToolName;
  input?: Record<string, unknown>;
  session_id?: string;
  session_title?: string;
};

export type WatchRequest =
  | { type: "WATCH_START"; tab_id?: number }
  | { type: "WATCH_STOP"; tab_id?: number }
  | { type: "WATCH_REPLAY_STEP"; tab_id?: number; step: RecordedWorkflowStep };

export type ExtensionRequest =
  | { type: "GET_CURRENT_TAB" }
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
