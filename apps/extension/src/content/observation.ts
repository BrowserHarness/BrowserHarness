export const MAX_OBSERVATION_TEXT = 6_000;
export const MAX_INTERACTIVE_ELEMENTS = 250;

export function compactVisibleText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_OBSERVATION_TEXT);
}
