import type {
  SiteSkillEvidence,
  SiteSkillParameter,
  SiteSkillRecipe
} from "./site-skill";

export const MAX_API_RECIPES = 5;
export const API_RESPONSE_MAX_CHARS = 20_000;

const NOISE_PATH =
  /(analytics|telemetry|track(ing)?|metrics|beacon|pixel|collect|\/log(s|ging)?(\/|$)|doubleclick|adserv|\/ads?\/|sentry|heartbeat|ping)/i;
const SENSITIVE_KEY =
  /(token|key|auth|secret|session|csrf|xsrf|sig(nature)?|password|cookie|jwt)/i;

function snake(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "param"
  );
}

/** JSON-ish GET responses on the page's own origin, with the query string turned into parameters. */
export function deriveApiRecipes(
  evidence: SiteSkillEvidence
): { recipes: SiteSkillRecipe[]; parameters: SiteSkillParameter[] } {
  const recipes: SiteSkillRecipe[] = [];
  const parameters: SiteSkillParameter[] = [];
  const seen = new Set<string>();

  for (const record of evidence.network) {
    if (recipes.length >= MAX_API_RECIPES) break;
    if (record.method.toUpperCase() !== "GET") continue;
    if (
      typeof record.status !== "number" ||
      record.status < 200 ||
      record.status > 299
    ) {
      continue;
    }
    if (!/json/i.test(record.mime_type || "")) continue;

    let url: URL;
    try {
      url = new URL(record.url);
    } catch {
      continue;
    }
    if (url.origin !== evidence.site.origin) continue;
    if (NOISE_PATH.test(url.pathname)) continue;
    if (seen.has(url.pathname)) continue;
    seen.add(url.pathname);

    const index = recipes.length + 1;
    const query: Array<{
      key: string;
      parameter: string;
      default?: string;
    }> = [];
    const parameterNames: string[] = [];
    for (const [key, value] of url.searchParams) {
      const sensitive = SENSITIVE_KEY.test(key);
      const name = `api${index}_${snake(key)}`;
      if (query.some((item) => item.key === key)) continue;
      query.push({
        key,
        parameter: name,
        ...(sensitive || !value ? {} : { default: value.slice(0, 200) })
      });
      parameterNames.push(name);
      parameters.push({
        name,
        label: key,
        type: "string",
        required: sensitive || !value,
        sensitive,
        source: { form_index: -1, field_name: key }
      });
    }

    recipes.push({
      id: `recipe-api-${index}`,
      name: `GET ${url.pathname}`,
      entry_url: evidence.site.url,
      form_index: -1,
      method: "GET",
      action: url.pathname,
      parameters: parameterNames,
      steps: [
        {
          kind: "api_fetch",
          method: "GET",
          path: url.pathname,
          query,
          response: {
            format: "json",
            max_chars: API_RESPONSE_MAX_CHARS
          },
          approval: "none_read_only"
        }
      ],
      verification: {
        required: true,
        checks: [
          {
            kind: "form_present",
            expect: { api_path: url.pathname, method: "GET" }
          }
        ]
      }
    });
  }

  return { recipes, parameters };
}

export type ApiFetchStep = Extract<
  SiteSkillRecipe["steps"][number],
  { kind: "api_fetch" }
>;

/** Builds the same-origin request URL from a recipe step; throws on any origin escape. */
export function buildApiFetchUrl(
  origin: string,
  step: ApiFetchStep,
  values: Record<string, unknown>
): string {
  if (!step.path.startsWith("/") || step.path.startsWith("//")) {
    throw new Error("SITE_SKILL_API_PATH_INVALID");
  }
  const url = new URL(step.path, origin);
  if (url.origin !== new URL(origin).origin) {
    throw new Error("SITE_SKILL_API_ORIGIN_ESCAPE");
  }
  for (const item of step.query) {
    const supplied = values[item.parameter];
    const value =
      supplied !== undefined ? supplied : item.default;
    if (value === undefined) {
      throw new Error(
        `SITE_SKILL_PARAMETER_REQUIRED: ${item.parameter}`
      );
    }
    if (typeof value !== "string") {
      throw new Error(
        `SITE_SKILL_PARAMETER_TYPE: ${item.parameter} must be string`
      );
    }
    url.searchParams.set(item.key, value);
  }
  return url.toString();
}

/** In-page expression: uses the page's own session (cookies) and returns a bounded body. */
export function apiFetchExpression(
  url: string,
  maxChars: number
): string {
  return `(async () => {
  const response = await fetch(${JSON.stringify(url)}, {
    method: "GET",
    credentials: "include",
    headers: { accept: "application/json, text/plain, */*" }
  });
  const text = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    content_type: response.headers.get("content-type") || "",
    truncated: text.length > ${maxChars},
    body: text.slice(0, ${maxChars})
  };
})()`;
}
