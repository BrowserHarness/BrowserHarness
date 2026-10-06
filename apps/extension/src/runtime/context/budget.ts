// How much context a model can take. BrowserHarness has no tokenizer, so
// tokens are estimated (about 4 Latin letters a token, one per other
// character). Windows come from the model's name where it is well known; a
// model served from this computer gets the usual local default; anything
// else gets a small, safe window rather than a guessed big one.
import type { ProviderConnection } from "../../settings/provider-store";
import type { ContextBudget, ContextSection } from "./types";

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

/** The model's context window, and how sure we are of it. */
export function contextWindowFor(
  connection?: Pick<ProviderConnection, "provider" | "model" | "baseUrl"> | null
): { window: number; source: ContextBudget["window_source"] } {
  if (!connection) return { window: 8192, source: "unknown, conservative" };
  // A model on this computer runs with whatever window the app gives it; LM Studio and Ollama start at 4096.
  if (connection.provider === "lm-studio" || connection.provider === "ollama") return { window: 4096, source: "provider default" };
  if (connection.provider === "claude-subscription") return { window: 200_000, source: "known model" };
  if (connection.provider === "chatgpt-subscription") return { window: 128_000, source: "known model" };
  const known = KNOWN_WINDOWS.find(([pattern]) => pattern.test(connection.model || ""));
  // Free plans like Groq's limit tokens per minute well below the window.
  if (/groq\.com/i.test(connection.baseUrl || "")) return { window: Math.min(known?.[1] ?? 8192, 8192), source: "provider default" };
  return known ? { window: known[1], source: "known model" } : { window: 8192, source: "unknown, conservative" };
}

/** A quarter of the window for everything sent with the request, never tiny, never huge. */
export function budgetFor(connection?: Pick<ProviderConnection, "provider" | "model" | "baseUrl"> | null): ContextBudget {
  const { window, source } = contextWindowFor(connection);
  return { target: Math.min(12_000, Math.max(1_000, Math.round(window / 4))), used: 0, window, window_source: source, counting: "estimated" };
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
