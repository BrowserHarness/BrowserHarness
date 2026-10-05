// The chat answer for a website command: data as a table when it is a list,
// otherwise a short readable summary.
import type { SiteCommand } from "../runtime/site-commands";
import type { ToolResult } from "../runtime/protocol";

const MAX_ROWS = 50;
const MAX_COLUMNS = 8;
const MAX_TEXT = 4000;

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  const clipped = text.length > 120 ? `${text.slice(0, 119)}…` : text;
  return clipped.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The list inside a response: the response itself, or its biggest array of objects. */
export function rowsIn(data: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(data)) return data.length && data.every(isRecord) ? data : null;
  if (!isRecord(data)) return null;
  let best: Record<string, unknown>[] | null = null;
  for (const value of Object.values(data)) {
    const rows = Array.isArray(value) ? rowsIn(value) : isRecord(value) ? rowsIn(value) : null;
    if (rows && rows.length > (best?.length ?? 0)) best = rows;
  }
  return best;
}

export function markdownTable(rows: Record<string, unknown>[]): string {
  const columns: string[] = [];
  for (const row of rows.slice(0, MAX_ROWS)) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key) && columns.length < MAX_COLUMNS) columns.push(key);
    }
  }
  const lines = [
    `| ${columns.map(cell).join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...rows.slice(0, MAX_ROWS).map((row) => `| ${columns.map((column) => cell(row[column])).join(" | ")} |`)
  ];
  return lines.join("\n");
}

export function siteCommandAnswer(command: SiteCommand, result: ToolResult<unknown>): string {
  if (!result.ok) {
    const message = result.error?.message || "It didn't work.";
    const drifted = /no longer matches|SITE_SKILL_VERIFICATION_FAILED|ORIGIN_MISMATCH/i.test(
      `${result.error?.code} ${message}`
    );
    return drifted
      ? `/${command.name} didn't run: ${command.site} has changed since BrowserHarness learned it. Ask me to learn the site again, or do the task normally.`
      : `/${command.name} didn't run: ${message}`;
  }
  const data = (isRecord(result.data) ? result.data : {}) as Record<string, unknown>;
  if (command.kind === "form") {
    return data.submitted
      ? `Done: filled and sent the form on ${command.site}. The page is open in its own tab.`
      : `Filled the form on ${command.site} without sending it. The page is open in its own tab.`;
  }
  const output = data.output;
  const rows = rowsIn(output);
  const note = data.truncated ? "\n\nThe site returned more than fits here, so the end is cut off." : "";
  if (rows) {
    const more = rows.length > MAX_ROWS ? `\n\nShowing the first ${MAX_ROWS} of ${rows.length}.` : "";
    return `**/${command.name}** on ${command.site}: ${rows.length} result${rows.length === 1 ? "" : "s"}.\n\n${markdownTable(rows)}${more}${note}`;
  }
  const text = typeof output === "string" ? output : JSON.stringify(output, null, 2);
  const clipped = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…` : text;
  return `**/${command.name}** on ${command.site}:\n\n\`\`\`\n${clipped}\n\`\`\`${note}`;
}
