// Which models a request may actually reach. The side panel, scheduled runs
// and the context budget all ask here, so the budget is worked out for the
// same models the request is sent to.
import type { CapabilityHealth } from "../settings/provider-store";

export interface RoutableConnection {
  id: string;
  chatHealth: CapabilityHealth;
  agentHealth: CapabilityHealth;
}

/** A chat goes to the main AI, then to the backup only if the backup passed the chat check. */
export function chatRoute<T extends RoutableConnection>(primary: T, fallback?: T | null): { primary: T; fallback: T | null } {
  return { primary, fallback: fallback?.chatHealth.status === "healthy" ? fallback : null };
}

/**
 * A browser task goes to the main AI unless it failed the browser-control
 * check, in which case a backup that passed it takes over. A backup that
 * passed is also kept in reserve behind a working main AI.
 */
export function agentRoute<T extends RoutableConnection>(primary: T, fallback?: T | null): { primary: T | null; fallback: T | null } {
  const healthyFallback = fallback?.agentHealth.status === "healthy" ? fallback : null;
  const agentPrimary = primary.agentHealth.status !== "failed" ? primary : healthyFallback;
  if (!agentPrimary) return { primary: null, fallback: null };
  return { primary: agentPrimary, fallback: agentPrimary.id === primary.id ? healthyFallback : null };
}
