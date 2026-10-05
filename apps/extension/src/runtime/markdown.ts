export type InlineNode =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; text: string; href: string };

export type BlockNode =
  | { type: "paragraph"; inline: InlineNode[] }
  | { type: "heading"; level: 1 | 2 | 3; inline: InlineNode[] }
  | { type: "list"; ordered: boolean; items: InlineNode[][] }
  | { type: "code"; text: string }
  | { type: "quote"; inline: InlineNode[] }
  | { type: "table"; headers: InlineNode[][]; rows: InlineNode[][][] };

/** The |---|---| line under a markdown table's header row. */
export const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** The cells of one markdown table row; an escaped `\|` stays a literal bar. */
export function splitTableRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "\\" && body[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function isTableStart(lines: string[], i: number): boolean {
  return lines[i].includes("|") && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]);
}

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<)]+)/g;

function safeHref(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) {
      nodes.push({ type: "text", text: text.slice(last, index) });
    }
    const token = match[0];
    if (match[1]) {
      nodes.push({ type: "code", text: token.slice(1, -1) });
    } else if (match[2]) {
      nodes.push({ type: "bold", text: token.slice(2, -2) });
    } else if (match[3]) {
      nodes.push({ type: "italic", text: token.slice(1, -1) });
    } else if (match[4]) {
      const parts = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      const href = parts ? safeHref(parts[2]) : null;
      nodes.push(
        href && parts
          ? { type: "link", text: parts[1], href }
          : { type: "text", text: token }
      );
    } else {
      const href = safeHref(token);
      nodes.push(
        href
          ? { type: "link", text: token, href }
          : { type: "text", text: token }
      );
    }
    last = index + token.length;
  }
  if (last < text.length) {
    nodes.push({ type: "text", text: text.slice(last) });
  }
  return nodes;
}

/** Small, HTML-free markdown subset. Nothing is ever interpreted as markup beyond these nodes. */
export function parseMarkdown(source: string): BlockNode[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: BlockNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length as 1 | 2 | 3,
        inline: parseInline(heading[2])
      });
      i += 1;
      continue;
    }
    if (isTableStart(lines, i)) {
      const headers = splitTableRow(line).map(parseInline);
      const rows: InlineNode[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]).map(parseInline));
        i += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }
    const bullet = /^\s*([-*]|\d+\.)\s+/;
    if (bullet.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: InlineNode[][] = [];
      while (i < lines.length && bullet.test(lines[i])) {
        items.push(parseInline(lines[i].replace(bullet, "")));
        i += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        quote.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({ type: "quote", inline: parseInline(quote.join(" ")) });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].startsWith("```") &&
      !/^#{1,3}\s/.test(lines[i]) &&
      !bullet.test(lines[i]) &&
      !lines[i].startsWith(">") &&
      !isTableStart(lines, i)
    ) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: "paragraph", inline: parseInline(para.join(" ")) });
  }
  return blocks;
}
