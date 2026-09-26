import type { PageObservation } from "./protocol";
import {
  directChatCompletion,
  nextAgentDecision,
  type AgentDecision
} from "./model-client";
import type { ProviderConnection } from "../settings/provider-store";

export interface RoutedResult<T> {
  result: T;
  connectionId: string;
  usedFallback: boolean;
}

export function isRecoverableProviderError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /\b429\b/.test(message) ||
    /\b5\d\d\b/.test(message) ||
    /timed out/i.test(message) ||
    /empty response/i.test(message) ||
    /failed the BrowserCrew structured agent capability/i.test(message) ||
    /Model did not return a BrowserCrew action/i.test(message)
  );
}

async function runWithFallback<T>(
  primary: ProviderConnection,
  fallback: ProviderConnection | null,
  run: (connection: ProviderConnection) => Promise<T>
): Promise<RoutedResult<T>> {
  try {
    return {
      result: await run(primary),
      connectionId: primary.id,
      usedFallback: false
    };
  } catch (error) {
    if (
      !fallback ||
      fallback.id === primary.id ||
      !isRecoverableProviderError(error)
    ) {
      throw error;
    }

    return {
      result: await run(fallback),
      connectionId: fallback.id,
      usedFallback: true
    };
  }
}

export async function directChatWithFallback(
  primary: ProviderConnection,
  fallback: ProviderConnection | null,
  prompt: string,
  signal?: AbortSignal
): Promise<RoutedResult<string>> {
  return runWithFallback(primary, fallback, (connection) =>
    directChatCompletion(connection, prompt, signal)
  );
}

export async function agentDecisionWithFallback(
  primary: ProviderConnection,
  fallback: ProviderConnection | null,
  task: string,
  observation: PageObservation,
  trail: string[],
  signal?: AbortSignal
): Promise<RoutedResult<AgentDecision>> {
  return runWithFallback(primary, fallback, (connection) =>
    nextAgentDecision(connection, task, observation, trail, signal)
  );
}
