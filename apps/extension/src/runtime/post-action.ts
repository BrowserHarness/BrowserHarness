import type { ToolName, ToolResult } from "./protocol";

/** Tools after which the page may look different. */
export const PAGE_CHANGING_TOOLS: ToolName[] = [
  "navigate",
  "back",
  "reload",
  "click",
  "type",
  "press_key",
  "trusted_click",
  "trusted_type",
  "trusted_key",
  "send_keys",
  "select_option",
  "hover",
  "drag",
  "dialog",
  "evaluate",
  "cdp",
  "scroll",
  "open_tab",
  "find_tab",
  "switch_tab"
];

/** These already wait for the new document before they return. */
const WAITS_FOR_LOAD: ToolName[] = ["navigate", "back", "reload", "open_tab"];

export function changesPage(
  tool: ToolName,
  input: Record<string, unknown>
): boolean {
  if (tool === "site_skill") return input.action === "run";
  return PAGE_CHANGING_TOOLS.includes(tool);
}

/**
 * A Site Skill run of a learned API operation answers without any page: there
 * is nothing to let settle or to look at afterwards.
 */
export function ranWithoutPage(tool: ToolName, result: ToolResult): boolean {
  if (tool !== "site_skill") return false;
  const run = (result.data as { run?: { output?: { api?: unknown } } } | undefined)?.run;
  return Boolean(run?.output?.api);
}

/** How long to let the page react before looking again. */
export function settleMsAfter(tool: ToolName): number {
  return WAITS_FOR_LOAD.includes(tool) ? 0 : 450;
}

/** Which tab to look at after an action: the one it opened or named. */
export function observationInputAfter(
  input: Record<string, unknown>,
  result: ToolResult
): Record<string, unknown> {
  const data = result.data;
  const resultTabId =
    data && typeof data === "object" ? (data as { tab_id?: unknown }).tab_id : undefined;
  if (typeof resultTabId === "number") return { tab_id: resultTabId };
  if (typeof input.tab_id === "number") return { tab_id: input.tab_id };
  return {};
}
