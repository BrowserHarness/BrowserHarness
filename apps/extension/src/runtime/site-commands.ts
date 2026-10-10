// Website → command: every recipe of a learned Site Skill becomes a named
// command with typed parameters, like `amazon-search --q kettle`. The side
// panel runs it with /name, coding agents get it as a tool, and the Bridge
// CLI runs it with `browserharness-bridge site <name>`.
import { apiRecipeNeedsApproval } from "./api-recipe";
import type { SiteSkillParameterType, SiteSkillRecipe } from "./site-skill";
import { listSiteSkillFamilies, type SiteSkillFamilyRecord } from "./site-skill-store";
import { loadAllSkills } from "./skills";
import { BUILT_IN_COMMANDS } from "./slash-commands";

export interface SiteCommandParameter {
  /** What the person types, e.g. "q". */
  name: string;
  /** The recipe's own parameter name, e.g. "api1_q". */
  key: string;
  label: string;
  type: SiteSkillParameterType;
  required: boolean;
  sensitive: boolean;
  options?: string[];
  default?: string;
}

export interface SiteCommand {
  name: string;
  /** Stable id for renaming: skill id + recipe id. */
  key: string;
  title: string;
  site: string;
  origin: string;
  entry_url: string;
  /** read: fetches the site's own data, never changes anything. form: fills and sends a form. */
  kind: "read" | "form";
  /** false for a learned API operation (API Recipe v2): it runs without opening the site */
  needs_page?: boolean;
  status: "proven" | "testing" | "check failed";
  skill_id: string;
  revision_id: string;
  recipe_id: string;
  parameters: SiteCommandParameter[];
  runs: number;
  worked: number;
}

const NAMES_KEY = "browserharness.siteCommandNames";
const GENERIC_SEGMENTS = /^(api|apis|v\d+|rest|json|graphql|public|internal|ajax|data|index(\.\w+)?)$/i;

function slug(value: string, max = 40): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/g, "")
  );
}

/** "www.amazon.co.uk" → "amazon", "127.0.0.1" → "local", "shop.example.com" → "shop-example". */
export function siteLabel(origin: string): string {
  let host = "";
  try {
    host = new URL(origin).hostname;
  } catch {
    return "site";
  }
  if (host === "localhost" || /^[\d.]+$/.test(host) || host.includes(":")) return "local";
  const labels = host.replace(/^www\d*\./, "").split(".");
  if (labels.length <= 1) return slug(labels[0] || "site") || "site";
  const secondLevel = /^(co|com|net|org|gov|edu|ac)$/;
  let end = labels.length - 1;
  if (end > 1 && secondLevel.test(labels[end - 1]) && labels[end].length === 2) end -= 1;
  const kept = labels.slice(Math.max(0, end - 2), end).filter((label) => !/^(m|app|web)$/.test(label));
  return slug(kept.join("-")) || "site";
}

/** "GET /api/v2/products/search" → "products-search"; a form → its name. */
export function recipeLabel(recipe: SiteSkillRecipe): string {
  const operation = recipe.steps.find((step) => step.kind === "api_operation");
  // a learned operation has its own name ("searchProducts" → "search-products")
  if (operation?.kind === "api_operation") {
    return slug(operation.contract.name.replace(/([a-z0-9])([A-Z])/g, "$1-$2")) || "data";
  }
  if (recipe.form_index < 0) {
    const segments = recipe.action
      .split("/")
      .map((segment) => segment.replace(/\.(json|php|aspx?)$/i, ""))
      .filter((segment) => segment && !GENERIC_SEGMENTS.test(segment) && !/^\d+$/.test(segment));
    return slug(segments.slice(-2).join("-")) || "data";
  }
  const label = slug(recipe.name);
  return !label || /^form-\d+$/.test(label) ? "form" : label;
}

function commandParameters(
  family: SiteSkillFamilyRecord,
  revisionIndex: number,
  recipe: SiteSkillRecipe
): SiteCommandParameter[] {
  const candidate = family.revisions[revisionIndex].candidate;
  const defaults = new Map<string, string>();
  for (const step of recipe.steps) {
    if (step.kind !== "api_fetch") continue;
    for (const query of step.query) {
      if (query.default !== undefined) defaults.set(query.parameter, query.default);
    }
  }
  const own = recipe.parameters
    .map((key) => candidate.parameters.find((parameter) => parameter.name === key))
    .filter((parameter): parameter is NonNullable<typeof parameter> => Boolean(parameter));
  // API parameters are stored as "api1_q"; people type "q".
  const friendly = own.map((parameter) => parameter.name.replace(/^api\d+_/, ""));
  return own.map((parameter, index) => {
    const name = friendly.indexOf(friendly[index]) === index && friendly.lastIndexOf(friendly[index]) === index
      ? friendly[index]
      : parameter.name;
    const fallback = defaults.get(parameter.name);
    return {
      name,
      key: parameter.name,
      label: parameter.label,
      type: parameter.type,
      required: parameter.required && fallback === undefined,
      sensitive: parameter.sensitive,
      ...(parameter.options?.length ? { options: parameter.options.slice(0, 50) } : {}),
      ...(fallback !== undefined && !parameter.sensitive ? { default: fallback } : {})
    };
  });
}

/**
 * One command per recipe of every Site Skill, from its active revision (or
 * its latest one while it is still being tested). `names` holds renames;
 * `reserved` are names already taken, such as built-in slash commands.
 */
export function buildSiteCommands(
  families: SiteSkillFamilyRecord[],
  names: Record<string, string> = {},
  reserved: string[] = []
): SiteCommand[] {
  const taken = new Set(reserved.map((name) => name.toLowerCase()));
  const commands: SiteCommand[] = [];
  const pending: Array<{ base: string; command: Omit<SiteCommand, "name"> }> = [];

  for (const family of families) {
    const revisionId = family.active_revision_id || family.latest_revision_id;
    const revisionIndex = family.revisions.findIndex((item) => item.revision_id === revisionId);
    if (revisionIndex < 0) continue;
    const candidate = family.revisions[revisionIndex].candidate;
    const verification = family.evaluations
      .filter((item) => item.revision_id === revisionId && item.kind === "structural-verification")
      .at(-1);
    const status: SiteCommand["status"] = family.active_revision_id
      ? "proven"
      : verification?.outcome === "failed"
        ? "check failed"
        : "testing";
    const site = (() => {
      try {
        return new URL(candidate.site.origin).hostname;
      } catch {
        return candidate.site.origin;
      }
    })();

    for (const recipe of candidate.recipes) {
      const key = `${family.id}:${recipe.id}`;
      const executions = (family.executions || []).filter((item) => item.recipe_id === recipe.id);
      const command: Omit<SiteCommand, "name"> = {
        key,
        title: recipe.form_index < 0
          ? `${candidate.name}: ${recipeLabel(recipe).replace(/-/g, " ")}`
          : `${candidate.name}: ${recipe.name} form`,
        site,
        origin: candidate.site.origin,
        entry_url: recipe.entry_url || candidate.site.entry_url,
        // a learned API write runs like a form: it asks the person first
        kind: recipe.form_index < 0 && !apiRecipeNeedsApproval(recipe) ? "read" : "form",
        ...(recipe.steps.some((step) => step.kind === "api_operation") ? { needs_page: false } : {}),
        status,
        skill_id: family.id,
        revision_id: revisionId,
        recipe_id: recipe.id,
        parameters: commandParameters(family, revisionIndex, recipe),
        runs: executions.length,
        worked: executions.filter((item) => item.outcome === "passed").length
      };
      const renamed = slug(names[key] || "");
      pending.push({ base: renamed || `${siteLabel(candidate.site.origin)}-${recipeLabel(recipe)}`, command });
    }
  }

  // Renamed commands keep their names first; the rest get -2, -3 on clashes.
  const ordered = [...pending].sort(
    (a, b) => Number(Boolean(names[b.command.key])) - Number(Boolean(names[a.command.key]))
  );
  for (const { base, command } of ordered) {
    let name = base;
    for (let count = 2; taken.has(name); count += 1) name = `${base}-${count}`;
    taken.add(name);
    commands.push({ name, ...command });
  }
  return pending.map(({ command }) => commands.find((item) => item.key === command.key) as SiteCommand);
}

export function findSiteCommand(commands: SiteCommand[], name: string): SiteCommand | null {
  const wanted = name.trim().replace(/^\//, "").toLowerCase();
  return commands.find((command) => command.name === wanted) || null;
}

/** "/name kettle" fills the one parameter that matters; "q=kettle page=2" or "--q kettle" names them. */
export function parseCommandArgs(command: SiteCommand, text: string): Record<string, string> {
  const source = text.trim();
  if (!source) return {};
  const values: Record<string, string> = {};
  const known = new Set(command.parameters.map((parameter) => parameter.name));
  const named = /(?:^|\s)(?:--)?([a-z_][a-z0-9_]*)(?:=|\s+)("([^"]*)"|'([^']*)'|\S+)/gi;
  let match: RegExpExecArray | null;
  while ((match = named.exec(source))) {
    const key = match[1];
    if (!known.has(key)) continue;
    if (!match[0].includes("=") && !match[0].trimStart().startsWith("--")) continue;
    values[key] = match[3] ?? match[4] ?? match[2];
  }
  if (Object.keys(values).length) return values;
  const main =
    command.parameters.find((parameter) => parameter.required && !parameter.sensitive) ||
    command.parameters.find((parameter) => !parameter.sensitive);
  if (main) values[main.name] = source.replace(/^["']|["']$/g, "");
  return values;
}

/** Turns the person's values into the recipe's own parameter names. */
export function recipeParameters(
  command: SiteCommand,
  values: Record<string, unknown>
): { ok: true; parameters: Record<string, unknown> } | { ok: false; error: string } {
  const unknown = Object.keys(values).filter(
    (name) => !command.parameters.some((parameter) => parameter.name === name || parameter.key === name)
  );
  if (unknown.length) {
    return {
      ok: false,
      error: `${command.name} has no ${unknown.join(", ")}. It takes: ${usage(command)}`
    };
  }
  const parameters: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const parameter of command.parameters) {
    const value = values[parameter.name] ?? values[parameter.key];
    if (value === undefined || value === "") {
      if (parameter.required) missing.push(parameter.name);
      continue;
    }
    parameters[parameter.key] = value;
  }
  if (missing.length) {
    return { ok: false, error: `${command.name} needs ${missing.join(", ")}. Usage: ${usage(command)}` };
  }
  return { ok: true, parameters };
}

export function usage(command: SiteCommand): string {
  const parts = command.parameters.map((parameter) =>
    parameter.required ? `${parameter.name}=…` : `[${parameter.name}=…]`
  );
  return [command.name, ...parts].join(" ");
}

export async function loadCommandNames(): Promise<Record<string, string>> {
  const stored = await chrome.storage.local.get(NAMES_KEY);
  const value = stored[NAMES_KEY];
  return value && typeof value === "object" ? (value as Record<string, string>) : {};
}

export async function renameSiteCommand(key: string, name: string): Promise<string> {
  const names = await loadCommandNames();
  const clean = slug(name);
  if (clean) names[key] = clean;
  else delete names[key];
  await chrome.storage.local.set({ [NAMES_KEY]: names });
  return clean;
}

/** Every site command, named so it never clashes with a built-in command or a Skill. */
export async function loadSiteCommands(): Promise<SiteCommand[]> {
  const [families, names, skills] = await Promise.all([
    listSiteSkillFamilies(),
    loadCommandNames(),
    // Every Space's Skills, so a site command never takes a /name used anywhere.
    loadAllSkills().catch(() => [])
  ]);
  return buildSiteCommands(families, names, [
    ...BUILT_IN_COMMANDS.map((command) => command.name),
    ...skills.map((skill) => skill.slug)
  ]);
}

/** What agents, the CLI and the help text see for a command. */
export function describeSiteCommand(command: SiteCommand) {
  return {
    name: command.name,
    title: command.title,
    site: command.site,
    kind: command.kind,
    status: command.status,
    usage: usage(command),
    parameters: command.parameters.map((parameter) => ({
      name: parameter.name,
      label: parameter.label,
      type: parameter.type,
      required: parameter.required,
      ...(parameter.default !== undefined ? { default: parameter.default } : {}),
      ...(parameter.options ? { options: parameter.options } : {})
    })),
    runs: command.runs,
    worked: command.worked
  };
}

export const SITE_COMMAND_NAMES_KEY = NAMES_KEY;
