// API Recipe v2 (docs/protocols/API-RECIPE-V2.md): a Site Skill recipe whose
// one step is a learned website operation contract. The Bridge learns and
// checks contracts; the extension stores them in the one Site Skill registry,
// with the same revisions, evaluations, promotion and rollback as UI recipes.
import type {
  SiteCandidateSkill,
  SiteSkillParameter,
  SiteSkillRecipe,
  SiteSkillRecipeStep
} from "./site-skill";

export const API_CONTRACT_VERSION = 2;

export type ApiTier = 1 | 2 | 3;
export type ApiSideEffect = "read" | "write" | "unknown";
export type ApiResultClass =
  | "ok"
  | "input"
  | "auth"
  | "rate_limited"
  | "blocked"
  | "network"
  | "schema_drift"
  | "endpoint_drift"
  | "ambiguous_write"
  | "approval_required"
  | "unavailable";

export interface ApiVerificationCheck {
  kind: "learned_examples" | "unseen_input" | "replay" | "repair_validation" | "health";
  passed: boolean;
  tier?: ApiTier;
  class?: string;
  arg_names: string[];
  item_count?: number;
  detail?: string;
  checked_at: string;
}

export interface ApiOperationParam {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  required: boolean;
  description?: string;
  example?: unknown;
  default?: unknown;
  pattern?: string;
}

/** The serialized contract. Upstream request/slot/response parts are kept opaque here. */
export interface ApiOperationContract {
  contract_version: 2;
  operation_id: string;
  name: string;
  description?: string;
  origin: string;
  side_effect: ApiSideEffect;
  side_effect_basis: string;
  request: { method: string; url: string; headers: Record<string, string>; body?: string };
  slots: unknown[];
  volatile: unknown[];
  params: ApiOperationParam[];
  session_refs: string[];
  session_sources: Array<{ ref: string; kind: "cookie" | "storage" | "page"; key?: string; path?: string }>;
  public?: string[];
  response: Record<string, unknown>;
  match: { method?: string; host?: string; path?: string; operationName?: string };
  trigger: { url: string; steps?: unknown[]; softFrom?: string };
  min_tier: ApiTier;
  learned_logged_in: boolean;
  transport: { preference: ApiTier[]; learned_tier?: ApiTier };
  verification: { status: "unverified" | "verified" | "failed"; checks: ApiVerificationCheck[] };
  provenance: {
    source: "two_example_learning" | "watch_me" | "network_capture" | "repair" | "upstream_spec";
    engine: string;
    learned_at: string;
    evidence_ids: string[];
    warnings: string[];
    parent_operation_id?: string;
  };
}

export type ApiOperationStep = Extract<SiteSkillRecipeStep, { kind: "api_operation" }>;

/** One result shape for every tier (Bridge outcome.mjs). */
export interface ApiCallResult {
  ok: boolean;
  class: ApiResultClass;
  tier: ApiTier;
  /** whether a request left for the site (absent: assume it did) */
  sent?: boolean;
  status?: number;
  ms?: number;
  data?: unknown;
  item_count?: number;
  truncated?: string;
  reason?: string;
  next?: string;
  operation_id?: string;
  fetched_at: string;
  fresh: true;
}

export function isApiContract(value: unknown): value is ApiOperationContract {
  if (!value || typeof value !== "object") return false;
  const contract = value as Partial<ApiOperationContract>;
  return (
    contract.contract_version === API_CONTRACT_VERSION &&
    typeof contract.operation_id === "string" &&
    typeof contract.name === "string" &&
    typeof contract.origin === "string" &&
    !!contract.request &&
    typeof contract.request.url === "string" &&
    Array.isArray(contract.params)
  );
}

export function apiOperationStep(recipe: SiteSkillRecipe): ApiOperationStep | undefined {
  return recipe.steps.find((step): step is ApiOperationStep => step.kind === "api_operation");
}

/** UI (forms and clicks), API (a learned operation) or hybrid (both: the UI is the fallback). */
export function recipeKind(recipe: SiteSkillRecipe): "ui" | "api" | "hybrid" {
  if (recipe.kind) return recipe.kind;
  const api = recipe.steps.some((step) => step.kind === "api_operation" || step.kind === "api_fetch");
  const ui = recipe.steps.some((step) => step.kind === "input" || step.kind === "submit");
  return api && ui ? "hybrid" : api ? "api" : "ui";
}

/** A write or an unclassified request goes through BrowserHarness approval. */
export function apiRecipeNeedsApproval(recipe: SiteSkillRecipe): boolean {
  const step = apiOperationStep(recipe);
  return Boolean(step && step.contract.side_effect !== "read");
}

const SENSITIVE = /(password|passwd|secret|token|otp|pin|cvv|card|ssn)/i;

/** A skill's parameters are shared by its recipes: an operation's "q" is the skill's "q". */
function parameterKey(_operation: string, name: string): string {
  return name.replace(/[^A-Za-z0-9_]+/g, "_").slice(0, 64) || "value";
}

/** Recipe parameters for a contract's params, named as the person typed them in the examples. */
export function apiParameters(contract: ApiOperationContract): SiteSkillParameter[] {
  return contract.params.map((param) => ({
    name: parameterKey(contract.name, param.name),
    label: param.name,
    type: param.type === "boolean" ? "boolean" : "string",
    required: param.required && param.default === undefined,
    sensitive: SENSITIVE.test(param.name),
    source: { form_index: -1, field_name: param.name }
  }));
}

/** Recipe parameter values → the contract's own param names. */
export function contractArgs(contract: ApiOperationContract, values: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const param of contract.params) {
    const keyed = values[parameterKey(contract.name, param.name)];
    const value = keyed !== undefined ? keyed : values[param.name];
    if (value !== undefined) args[param.name] = value;
  }
  return args;
}

export function apiRecipeFromContract(contract: ApiOperationContract, entryUrl: string): SiteSkillRecipe {
  const path = (() => {
    try {
      return new URL(contract.request.url).pathname;
    } catch {
      return "/";
    }
  })();
  return {
    id: `recipe-api-v2-${contract.operation_id.replace(/^op-/, "")}`,
    name: contract.description || contract.name,
    kind: "api",
    entry_url: entryUrl,
    form_index: -1,
    method: contract.request.method.toUpperCase(),
    action: path,
    parameters: apiParameters(contract).map((parameter) => parameter.name),
    steps: [
      {
        kind: "api_operation",
        contract,
        approval: contract.side_effect === "read" ? "none_read_only" : "browserharness_runtime"
      }
    ],
    verification: {
      required: true,
      checks: [{ kind: "form_present", expect: { api_operation: contract.operation_id, method: contract.request.method } }]
    }
  };
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "site"
  );
}

/**
 * A Site Skill revision with the learned operation in it: a new skill for the
 * site, or the given one with the operation added (or replaced, when the same
 * operation was learned before).
 */
export function withApiRecipe(
  base: SiteCandidateSkill | null,
  input: { contract: ApiOperationContract; entry_url: string; title: string; name?: string; evidence_id: string; captured_at: string }
): SiteCandidateSkill {
  const recipe = apiRecipeFromContract(input.contract, input.entry_url);
  const parameters = apiParameters(input.contract);
  if (base) {
    if (base.site.origin !== input.contract.origin) {
      throw new Error(`SITE_SKILL_ORIGIN_MISMATCH: the operation is on ${input.contract.origin}, the skill on ${base.site.origin}`);
    }
    const recipes = [...base.recipes.filter((item) => item.id !== recipe.id), recipe];
    const kept = base.parameters.filter((item) => !parameters.some((parameter) => parameter.name === item.name));
    return { ...base, recipes, parameters: [...kept, ...parameters], verification: undefined };
  }
  const name = input.name?.trim() || input.title.trim() || new URL(input.contract.origin).hostname;
  return {
    schema_version: 1,
    id: `SK-SITE-${input.evidence_id.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48)}`,
    slug: slug(name),
    name,
    version: "0.1.0",
    status: "candidate",
    lifecycle: { auto_promote: false, promotion_requires_evaluation: true },
    site: { origin: input.contract.origin, entry_url: input.entry_url, title: input.title },
    parameters,
    recipes: [recipe],
    network_candidates: [],
    safety: {
      execution_requires_fresh_resolution: true,
      approval_policy: "preserve_browserharness_approval_rules",
      structural_analysis_is_not_execution_proof: true
    },
    provenance: {
      source_kind: "api_learning_v2",
      evidence_id: input.evidence_id,
      captured_at: input.captured_at,
      ax_target_count: 0,
      form_count: 0,
      network_request_count: 0
    }
  };
}
