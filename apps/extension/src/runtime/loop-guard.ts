import type { AgentDecision } from "./model-client";

export interface LoopGuardState {
  recentSignatures: string[];
  totalActions: number;
}

export function createLoopGuard(): LoopGuardState {
  return { recentSignatures: [], totalActions: 0 };
}

export function actionSignature(decision: AgentDecision): string {
  if (decision.kind === "final") return "final";
  const stableInput = Object.entries(decision.input)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("&");
  return `${decision.tool}:${stableInput}`;
}

/** Most actions one task may take before BrowserHarness stops it. */
export const MAX_TASK_ACTIONS = 40;

/**
 * `pageKey` identifies the page state the action was chosen on (url plus
 * element list). The same action on a page that changed in between (scrolling
 * a feed, pressing Tab through a form) is progress, not a loop.
 */
export function registerDecision(
  state: LoopGuardState,
  decision: AgentDecision,
  pageKey = ""
): { ok: true } | { ok: false; reason: string } {
  if (decision.kind === "final") return { ok: true };

  const signature = `${actionSignature(decision)}@${pageKey}`;
  state.totalActions += 1;
  state.recentSignatures.push(signature);
  state.recentSignatures = state.recentSignatures.slice(-6);

  const repeats = state.recentSignatures.filter(
    (candidate) => candidate === signature
  ).length;

  if (repeats >= 3) {
    return {
      ok: false,
      reason: `I kept repeating the same ${decision.tool} on an unchanged page, so I stopped.`
    };
  }

  if (state.totalActions > MAX_TASK_ACTIONS) {
    return {
      ok: false,
      reason: `I reached the limit of ${MAX_TASK_ACTIONS} actions for one task, so I stopped.`
    };
  }

  return { ok: true };
}

/** Short fingerprint of a page state for the loop guard. */
export function pageKeyFor(observation: {
  url?: string;
  snapshot?: string;
  visible_text?: string;
}): string {
  const text = `${observation.url || ""}|${observation.snapshot || ""}|${(observation.visible_text || "").slice(0, 2000)}`;
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (Math.imul(31, hash) + text.charCodeAt(index)) | 0;
  }
  return hash.toString(36);
}
