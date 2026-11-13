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

const TYPING_TOOLS = new Set(["type", "trusted_type", "send_keys", "trusted_key"]);

export function isTypingTool(tool: string): boolean {
  return TYPING_TOOLS.has(tool);
}
const SECRET_FIELD =
  /\b(password|passcode|pin|cvv|cvc|security code|card number|credit card|debit card|expiry|expiration|one[- ]time code|otp|2fa|verification code|iban|routing|account number)\b/i;

/**
 * Level 4: typing into a password, card or one-time-code field. The
 * question names the field so ALWAYS_ASK keeps it for the person, which
 * stops a page from steering the agent into handing over a secret.
 */
export function secretFieldQuestion(
  observation: PageObservation,
  tool: ToolName,
  input: Record<string, unknown>
): string | null {
  if (!TYPING_TOOLS.has(tool) || typeof input.element_id !== "string") return null;
  const element = observation.elements.find(
    (item) => item.element_id === input.element_id || item.semantic_ref === input.element_id
  );
  if (!element) return null;
  const isSecret = element.type === "password" || SECRET_FIELD.test(element.accessible_name || "");
  if (!isSecret) return null;
  return `Type into the password or card field “${element.accessible_name || element.type || "this field"}” on ${hostOf(observation.url)}`;
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
  if (mode === "guarded") {
    const secret = secretFieldQuestion(observation, tool, input);
    if (secret) return secret;
  }
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

/**
 * Whether a question can be answered yes without the person:
 * - auto (level 3): not payments/account security, not "every time" writes
 * - guarded (level 4): everything except payments/passwords/account security
 * - full (level 5): everything
 */
export function autoApproves(mode: ApprovalMode, description: string): boolean {
  switch (mode) {
    case "full":
      return true;
    case "guarded":
      return !ALWAYS_ASK.test(description);
    case "auto":
      return !ALWAYS_ASK.test(description) && !asksEveryTime(description);
    default:
      return false;
  }
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
  if (autoApproves(mode, description)) return "auto";
  if (asksEveryTime(description)) return null;
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
