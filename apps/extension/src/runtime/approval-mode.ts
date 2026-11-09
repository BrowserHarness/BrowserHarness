import type { ApprovalMode } from "../settings/preferences";
import type { PageObservation, ToolName } from "./protocol";
import { changesPage } from "./post-action";
import { isGrantableHost, isHostGranted, normalizeGrantHost, type SiteGrant } from "../settings/site-grants";

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

/**
 * A write: a learned API operation that may change data, or a Site Skill
 * recipe that submits. It is asked before every run: neither automatic mode
 * nor "Always allow on this site" answers it (RC3 acceptance).
 */
const EVERY_TIME = /It may change data there|” and submit on /;

export function asksEveryTime(description: string): boolean {
  return EVERY_TIME.test(description);
}

/** Whether a question can be answered yes without the person, in automatic mode. */
export function autoApproves(mode: ApprovalMode, description: string): boolean {
  return mode === "auto" && !ALWAYS_ASK.test(description) && !asksEveryTime(description);
}

/**
 * Whether a question is answered yes without showing it: "auto" in automatic
 * mode, "site" when the person chose "Always allow on this site", else null.
 */
export function approvalShortcut(
  mode: ApprovalMode,
  description: string,
  host: string,
  grants: SiteGrant[]
): "auto" | "site" | null {
  if (asksEveryTime(description)) return null;
  if (autoApproves(mode, description)) return "auto";
  if (host && isHostGranted(grants, host)) return "site";
  return null;
}

/** Whether the question may offer "Always allow on this site". */
export function offersSiteGrant(description: string, host: string): boolean {
  return !asksEveryTime(description) && isGrantableHost(normalizeGrantHost(host));
}

export interface ApprovalQuestion {
  description: string;
  host: string;
  resolve: (yes: boolean) => void;
}

/**
 * Shows a question until the person answers it. The first answer counts and
 * takes the question away: Cancel, like Approve, closes it.
 */
export function askPerson(
  show: (question: ApprovalQuestion | null) => void,
  description: string,
  host: string
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let answered = false;
    show({
      description,
      host,
      resolve: (yes) => {
        if (answered) return;
        answered = true;
        show(null);
        resolve(yes);
      }
    });
  });
}
