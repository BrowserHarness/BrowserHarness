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

export function registerDecision(
  state: LoopGuardState,
  decision: AgentDecision
): { ok: true } | { ok: false; reason: string } {
  if (decision.kind === "final") return { ok: true };

  const signature = actionSignature(decision);
  state.totalActions += 1;
  state.recentSignatures.push(signature);
  state.recentSignatures = state.recentSignatures.slice(-6);

  const repeats = state.recentSignatures.filter(
    (candidate) => candidate === signature
  ).length;

  if (repeats >= 3) {
    return {
      ok: false,
      reason: `BrowserCrew detected a repeated action loop: ${decision.tool}`
    };
  }

  if (state.totalActions > 12) {
    return {
      ok: false,
      reason: "BrowserCrew reached the bounded action limit."
    };
  }

  return { ok: true };
}
