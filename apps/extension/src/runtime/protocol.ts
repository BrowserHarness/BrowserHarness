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
}

export interface PageObservation {
  tab_id: number;
  url: string;
  title: string;
  visible_text: string;
  elements: InteractiveElement[];
}

export type BrowserToolRequest = {
  type: "BROWSER_TOOL";
  tool: ToolName;
  input?: Record<string, unknown>;
};

export type ExtensionRequest =
  | { type: "GET_CURRENT_TAB" }
  | BrowserToolRequest;

export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}
