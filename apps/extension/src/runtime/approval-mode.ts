import type { ApprovalMode } from "../settings/preferences";
import type { PageObservation, ToolName } from "./protocol";
import { changesPage } from "./post-action";

/** Even automatic mode always asks before these. */
export const ALWAYS_ASK =
  /\b(buy|purchase|checkout|check out|place order|pay|payment|card|password|passcode|2fa|delete account|close account|transfer|wire|withdraw)\b/i;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || "this page";
  } catch {
    return "this page";
  }
}

/** A plain description of any page-changing action, for "ask every time" mode. */
export function describeAction(
  observation: PageObservation,
  tool: ToolName,
  input: Record<string, unknown>
): string {
  const host = hostOf(observation.url);
  const element =
    typeof input.element_id === "string"
      ? observation.elements.find((item) => item.element_id === input.element_id)
      : undefined;
  const target = element?.accessible_name ? `“${element.accessible_name}”` : "this control";
  switch (tool) {
    case "click":
    case "trusted_click":
      return `Click ${target} on ${host}`;
    case "type":
    case "trusted_type":
      return `Type “${String(input.text ?? "").slice(0, 60)}” into ${target} on ${host}`;
    case "press_key":
    case "trusted_key":
    case "send_keys":
      return `Press ${String(input.key ?? input.keys ?? "a key")} on ${host}`;
    case "navigate":
    case "open_tab":
      return `Open ${String(input.url ?? "a page")}`;
    case "select_option":
      return `Choose “${String(input.value ?? input.values ?? "")}” in ${target} on ${host}`;
    default:
      return `Use ${tool} on ${host}`;
  }
}

/**
 * The approval question for an action under the chosen mode, or null when it
 * may go ahead. `riskyDescription` is what the normal rules would ask.
 */
export function approvalFor(
  mode: ApprovalMode,
  riskyDescription: string | null,
  observation: PageObservation,
  tool: ToolName,
  input: Record<string, unknown>
): string | null {
  if (mode === "every") {
    if (riskyDescription) return riskyDescription;
    // Looking around (scroll, wait, read) never needs a question.
    if (!changesPage(tool, input) || ["scroll", "wait", "hover", "find_tab", "switch_tab"].includes(tool)) {
      return null;
    }
    return describeAction(observation, tool, input);
  }
  return riskyDescription;
}

/** Whether a question can be answered yes without the person, in automatic mode. */
export function autoApproves(mode: ApprovalMode, description: string): boolean {
  return mode === "auto" && !ALWAYS_ASK.test(description);
}
