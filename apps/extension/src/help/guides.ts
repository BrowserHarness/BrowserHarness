// The help guides, copied from the knowledge base by scripts/sync-help.mjs.
import type { GuideSlug } from "./problems";

export interface Guide {
  slug: string;
  title: string;
  summary: string;
  /** The guide text, without its title, related links and sources. */
  body: string;
  /** Other guides listed under "## Related". */
  related: string[];
}

function field(frontmatter: string, name: string): string {
  const match = frontmatter.match(new RegExp(`^${name}:\\s*(.*)$`, "m"));
  return (match?.[1] || "").trim().replace(/^"(.*)"$/, "$1");
}

export function parseGuide(text: string): Guide {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const frontmatter = match?.[1] || "";
  let body = match ? match[2] : text;
  body = body.replace(/^\s*# .*\n/, "");
  const relatedStart = body.search(/^## Related\b/m);
  const relatedText = relatedStart >= 0 ? body.slice(relatedStart).split(/^## Sources\b/m)[0] : "";
  const related = [...relatedText.matchAll(/\[\[knowledge\/help\/([a-z0-9-]+)\]\]/g)].map((item) => item[1]);
  const cut = body.search(/^## (Related|Sources)\b/m);
  if (cut >= 0) body = body.slice(0, cut);
  return {
    slug: field(frontmatter, "slug"),
    title: field(frontmatter, "title"),
    summary: field(frontmatter, "summary"),
    body: body.trim(),
    related
  };
}

const files = import.meta.glob("./articles/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export const GUIDES: Guide[] = Object.values(files)
  .map(parseGuide)
  .filter((guide) => guide.slug)
  .sort((a, b) => a.title.localeCompare(b.title));

export function findGuide(slug: string | undefined): Guide | undefined {
  return slug ? GUIDES.find((guide) => guide.slug === slug) : undefined;
}

/** Setup guides first in the Help list; the rest are for when something goes wrong. */
export const SETUP_GUIDES: GuideSlug[] = ["connect-your-ai", "set-up-helper-app"];
