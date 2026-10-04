export const TRAIL_RECENT_KEEP = 8;
const DIGEST_ENTRY_MAX = 110;
const DIGEST_TOTAL_MAX = 1600;

function squash(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** One short line per old step: tool name plus the first URL/title evidence, never the raw result payload. */
export function digestTrailEntry(entry: string): string {
  const text = squash(entry);
  const tool = /^([a-z_]+):/.exec(text)?.[1] ?? "";
  const url = /https?:\/\/[^\s"\\]+/.exec(text)?.[0];
  const title = /"title"\s*:\s*"([^"]{1,60})/.exec(text)?.[1];
  const ok = /"ok"\s*:\s*false/.test(text)
    ? " FAILED"
    : "";
  const parts = [tool || text.slice(0, 30)];
  if (title) parts.push(`“${title}”`);
  if (url) parts.push(url);
  const line = `${parts.join(" ")}${ok}`;
  return line.length > DIGEST_ENTRY_MAX
    ? `${line.slice(0, DIGEST_ENTRY_MAX - 1)}…`
    : line;
}

/**
 * Keeps the latest steps verbatim and folds older steps into a short digest so long tasks
 * do not forget what they already found. Deterministic; no extra model call.
 */
export function renderTrailForPrompt(
  trail: string[],
  keep = TRAIL_RECENT_KEEP
): string {
  if (trail.length === 0) return "No actions yet.";
  const recent = trail.slice(-keep);
  const older = trail.slice(0, Math.max(trail.length - keep, 0));
  if (older.length === 0) return recent.join("\n");

  const lines: string[] = [];
  let used = 0;
  for (let i = older.length - 1; i >= 0; i -= 1) {
    const line = `- ${digestTrailEntry(older[i])}`;
    if (used + line.length > DIGEST_TOTAL_MAX) break;
    used += line.length;
    lines.unshift(line);
  }
  const dropped = older.length - lines.length;
  const header = `EARLIER STEPS (${older.length} compacted${dropped ? `, ${dropped} oldest omitted` : ""}):`;
  return [header, ...lines, "RECENT STEPS:", ...recent].join("\n");
}
