export const MAX_POLISH_INPUT_CHARS = 2000;

/** Instruction for the chat model; the user's draft is quoted as data and may not add requirements. */
export function buildPolishPrompt(draft: string): string {
  const text = draft.trim().slice(0, MAX_POLISH_INPUT_CHARS);
  return [
    "Rewrite the browser-task request below so it is clear and specific for an automation agent.",
    "Keep the user's intent and every detail they gave. Do not add new goals, sites, steps or permissions. Do not answer the request.",
    "Return only the rewritten request as plain text, no quotes, no preamble.",
    "",
    `REQUEST:\n${text}`
  ].join("\n");
}

export function cleanPolishedPrompt(
  output: string,
  original: string
): string {
  let text = output.trim();
  text = text.replace(/^```[a-z]*\n?|```$/gi, "").trim();
  text = text.replace(/^(rewritten request|request)\s*:\s*/i, "").trim();
  if (
    text.length > 1 &&
    /^["“].*["”]$/s.test(text)
  ) {
    text = text.slice(1, -1).trim();
  }
  if (!text || text.length > MAX_POLISH_INPUT_CHARS * 2) return original;
  return text;
}
