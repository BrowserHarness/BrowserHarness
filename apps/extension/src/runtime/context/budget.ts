// How much context a model can take. BrowserHarness has no tokenizer, so
// tokens are estimated (about 4 Latin letters a token, one per other
// character). Windows come from the model's name where it is well known; a
// model served from this computer gets the usual local default; anything
// else gets a small, safe window rather than a guessed big one.
import type { ProviderConnection } from "../../settings/provider-store";
import { agentRoute, chatRoute, type RoutableConnection } from "../route";
import type { ContextBudget, ContextSection, ModelBudget, RouteBudget } from "./types";

export function estimateTokens(text: string): number {
  let other = 0;
  for (const char of text) if (char.charCodeAt(0) > 0x2000) other += 1;
  return Math.ceil((text.length - other) / 4) + other;
}

const KNOWN_WINDOWS: Array<[RegExp, number]> = [
  [/claude|sonnet|opus|haiku/i, 200_000],
  [/gemini/i, 1_000_000],
  [/gpt-?5|gpt-?4\.1|gpt-?4o|\bo[134](-mini)?\b/i, 128_000],
  [/gpt-?3\.5/i, 16_000],
  [/llama-?3\.[1-3]|llama-?4|mistral-(large|medium)|mixtral/i, 128_000],
  [/deepseek/i, 64_000],
  [/qwen/i, 32_768],
  [/gemma/i, 32_768]
];

type BudgetConnection = Pick<ProviderConnection, "provider" | "model" | "baseUrl">;

/** The model's context window, and how sure we are of it. A provider's rate limit is not a window (see providerBudgetCap). */
export function contextWindowFor(connection?: BudgetConnection | null): { window: number; source: ModelBudget["window_source"] } {
  if (!connection) return { window: 8192, source: "unknown, conservative" };
  // A model on this computer runs with whatever window the app gives it; LM Studio and Ollama start at 4096.
  if (connection.provider === "lm-studio" || connection.provider === "ollama") return { window: 4096, source: "provider default" };
  if (connection.provider === "claude-subscription") return { window: 200_000, source: "known model" };
  if (connection.provider === "chatgpt-subscription") return { window: 128_000, source: "known model" };
  const known = KNOWN_WINDOWS.find(([pattern]) => pattern.test(connection.model || ""));
  return known ? { window: known[1], source: "known model" } : { window: 8192, source: "unknown, conservative" };
}

/**
 * A provider's per-request budget, separate from the model's window.
 *
 * Groq limits tokens per minute, and on its free plan that limit is far
 * below the model's window, so a full-window request is refused. We can't
 * tell a free account from a paid one, so the cap is conservative: it fits
 * the free plan, and a paid plan simply gets a smaller context than it could
 * take. Nothing is looked up online.
 */
export const GROQ_REQUEST_BUDGET = 2048;

export function providerBudgetCap(connection?: BudgetConnection | null): { cap: number; reason: string } | null {
  if (connection && /groq\.com/i.test(connection.baseUrl || "")) return { cap: GROQ_REQUEST_BUDGET, reason: "conservative Groq request budget" };
  return null;
}

/** One model's budget: a quarter of its window (never tiny, never huge), then any provider cap. */
export function modelBudgetFor(connection?: BudgetConnection | null): ModelBudget {
  const { window, source } = contextWindowFor(connection);
  const before = Math.min(12_000, Math.max(1_000, Math.round(window / 4)));
  const cap = providerBudgetCap(connection);
  return {
    ...(connection ? { provider: connection.provider, model: connection.model } : {}),
    model_window: window,
    window_source: source,
    context_target_before_provider_cap: before,
    ...(cap ? { provider_budget_cap: cap.cap, provider_budget_reason: cap.reason } : {}),
    final_target: cap ? Math.min(before, cap.cap) : before
  };
}

function toBudget(model: ModelBudget, route?: RouteBudget): ContextBudget {
  return {
    target: route?.safe_target ?? model.final_target,
    used: 0,
    model_window: model.model_window,
    window_source: model.window_source,
    context_target_before_provider_cap: model.context_target_before_provider_cap,
    ...(model.provider_budget_cap ? { provider_budget_cap: model.provider_budget_cap, provider_budget_reason: model.provider_budget_reason } : {}),
    ...(route ? { route } : {}),
    counting: "estimated"
  };
}

/** The budget for one model. */
export function budgetFor(connection?: BudgetConnection | null): ContextBudget {
  return toBudget(modelBudgetFor(connection));
}

export interface RouteInput {
  primary?: (BudgetConnection & Partial<RoutableConnection>) | null;
  fallback?: (BudgetConnection & Partial<RoutableConnection>) | null;
  intent: "chat" | "browser";
}

const UNCHECKED = { status: "unknown" } as const;
const routable = <T extends BudgetConnection & Partial<RoutableConnection>>(connection: T): T & RoutableConnection => ({
  ...connection,
  id: connection.id ?? `${connection.provider}:${connection.model}`,
  chatHealth: connection.chatHealth ?? UNCHECKED,
  agentHealth: connection.agentHealth ?? UNCHECKED
});

/**
 * The budget that is safe for every model this request may reach: the main
 * AI and, when it would be used, the backup. A chat counts the backup only
 * if it passed the chat check; a browser task only if it passed the
 * browser-control check, the same rules the request is routed by
 * (runtime/route.ts). The smallest target wins.
 */
export function budgetForRoute({ primary, fallback, intent }: RouteInput): ContextBudget {
  if (!primary) return toBudget(modelBudgetFor(null));
  const main = routable(primary);
  const backup = fallback ? routable(fallback) : null;
  const route = intent === "chat" ? chatRoute(main, backup) : agentRoute(main, backup);
  const receivers = [route.primary, route.fallback].filter((item): item is NonNullable<typeof item> => Boolean(item));
  // A browser task with no usable model still gets the main AI's budget (it will be refused anyway).
  const first = route.primary ?? main;
  const firstBudget = modelBudgetFor(first);
  const secondBudget = route.fallback ? modelBudgetFor(route.fallback) : null;
  const notCounted: RouteBudget["fallback_not_counted"] = !backup
    ? "no backup set"
    : receivers.includes(backup)
      ? undefined
      : intent === "chat"
        ? "backup did not pass the chat check"
        : "backup did not pass the browser-control check";
  const limitedByFallback = Boolean(secondBudget && secondBudget.final_target < firstBudget.final_target);
  const safe = limitedByFallback && secondBudget ? secondBudget : firstBudget;
  // When the backup takes over a browser task it is the only model, so it is the route's primary.
  const routeBudget: RouteBudget = {
    intent,
    ...(route.primary && route.primary !== main ? { main_not_counted: "main AI did not pass the browser-control check; the backup does the task" as const } : {}),
    primary: firstBudget,
    fallback: secondBudget,
    ...(notCounted ? { fallback_not_counted: notCounted } : {}),
    limited_by: limitedByFallback ? "fallback" : "primary",
    safe_target: safe.final_target
  };
  return toBudget(safe, routeBudget);
}

/** The most each section may take, as a share of the target. Higher authority fills first. */
export const SECTION_SHARE: Record<ContextSection, number> = {
  request: 1,
  conversation: 0.45,
  instructions: 0.25,
  facts: 0.15,
  decisions: 0.1,
  skills: 0.25,
  history: 0.2,
  episodes: 0.15,
  earlier: 0.1
};
