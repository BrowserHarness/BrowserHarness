// API Recipe v2: the operation contract a Site Skill recipe carries for a
// learned website operation (docs/protocols/API-RECIPE-V2.md). It wraps the
// upstream API Anything Operation (request template, slots, response recipe)
// with what BrowserHarness needs around it: side-effect class, transport
// preference, verification evidence and provenance. Serializable and
// inspectable; never holds a cookie, token or session value.
import { createHash } from "node:crypto";
import * as z from "zod/v4";
import { OperationSchema, ParamSchema, ResponseSchema, SlotSchema, TriggerSchema, MatchSchema, VolatileSchema, RequestSchema } from "../../vendor/api-anything/dist/spec.js";
import { sessionSources } from "./session.mjs";
import { API_ANYTHING_COMMIT } from "./upstream-adapter.mjs";

export const API_CONTRACT_VERSION = 2;
export const ENGINE_ID = `browserharness-api-engine/1 (api-anything@${API_ANYTHING_COMMIT.slice(0, 7)})`;

const Tier = z.union([z.literal(1), z.literal(2), z.literal(3)]);

export const SideEffect = z.enum(["read", "write", "unknown"]);

const VerificationCheck = z.object({
  kind: z.enum(["learned_examples", "unseen_input", "replay", "repair_validation", "health"]),
  passed: z.boolean(),
  tier: Tier.optional(),
  class: z.string().optional(),
  /** names of the args only; values are in the params' examples when they may be kept */
  arg_names: z.array(z.string()).default([]),
  item_count: z.number().int().nonnegative().optional(),
  detail: z.string().max(500).optional(),
  checked_at: z.string()
});

export const ApiOperationContractSchema = z.object({
  contract_version: z.literal(API_CONTRACT_VERSION),
  operation_id: z.string().min(1),
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  origin: z.string().url(),
  side_effect: SideEffect,
  side_effect_basis: z.string().max(300),
  request: RequestSchema,
  slots: z.array(SlotSchema).default([]),
  volatile: z.array(VolatileSchema).default([]),
  params: z.array(ParamSchema).default([]),
  /** names of the cookie:/session: references the template uses; values are resolved at call time only */
  session_refs: z.array(z.string()).default([]),
  /** where each ref's value comes from at call time: a cookie, a page storage key, or only a page */
  session_sources: z
    .array(
      z.object({
        ref: z.string(),
        kind: z.enum(["cookie", "storage", "page"]),
        key: z.string().optional(),
        path: z.string().optional()
      })
    )
    .default([]),
  public: z.array(z.string()).optional(),
  response: ResponseSchema,
  match: MatchSchema,
  trigger: TriggerSchema,
  min_tier: Tier.default(1),
  learned_logged_in: z.boolean().default(false),
  transport: z
    .object({
      preference: z.array(Tier).default([1, 2, 3]),
      /** the tier that last answered ok, remembered per operation */
      learned_tier: Tier.optional()
    })
    .default({ preference: [1, 2, 3] }),
  verification: z
    .object({
      status: z.enum(["unverified", "verified", "failed"]),
      checks: z.array(VerificationCheck).default([])
    })
    .default({ status: "unverified", checks: [] }),
  provenance: z.object({
    source: z.enum(["two_example_learning", "watch_me", "network_capture", "repair", "upstream_spec"]),
    engine: z.string(),
    learned_at: z.string(),
    evidence_ids: z.array(z.string()).default([]),
    warnings: z.array(z.string().max(500)).default([]),
    parent_operation_id: z.string().optional(),
    /** the inputs a person typed to teach it (never kept when a param is private), for health checks and repair */
    example_inputs: z
      .object({
        learning: z.array(z.record(z.string(), z.unknown())).max(2),
        unseen: z.record(z.string(), z.unknown()).optional()
      })
      .optional()
  })
});

export function parseContract(input) {
  const result = ApiOperationContractSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`API_CONTRACT_INVALID: ${z.prettifyError(result.error).split("\n").slice(0, 6).join("; ")}`);
  }
  return result.data;
}

/** The upstream Operation the vendored codec, http and classifier work on. */
export function toUpstreamOperation(contract) {
  return OperationSchema.parse({
    name: contract.name,
    ...(contract.description ? { description: contract.description } : {}),
    request: contract.request,
    slots: contract.slots,
    volatile: contract.volatile,
    trigger: contract.trigger,
    match: contract.match,
    response: contract.response,
    params: contract.params,
    readOnly: contract.side_effect === "read",
    ...(contract.public?.length ? { public: contract.public } : {}),
    minTier: contract.min_tier,
    learnedLoggedIn: contract.learned_logged_in
  });
}

const WRITE_PATH =
  /(^|[/_.-])(add|create|delete|remove|destroy|update|edit|save|submit|post|send|vote|upvote|downvote|like|unlike|follow|unfollow|subscribe|unsubscribe|purchase|buy|checkout|order|pay|cart|logout|signout|sign-out|register|signup|comment|reply|share|invite|transfer|cancel|book|reserve|archive|mute|block|report)([/_.-]|$)/i;
const READ_PATH = /(^|[/_.-])(search|query|find|list|lookup|get|fetch|read|autocomplete|suggest|typeahead|browse|filter|results?|feed|details?|info|view)([/_.-]|$)/i;

/**
 * Conservative side-effect class from evidence, never from the method alone.
 * A GET to an action-looking path is unknown; a POST is read only with a
 * GraphQL query, a search-like path, or a person's say-so.
 */
export function classifySideEffect(request, { operationName, declared } = {}) {
  if (declared === "write") return { side_effect: "write", basis: "declared a write by the person" };
  if (declared === "read") return { side_effect: "read", basis: "confirmed read-only by the person" };
  const method = String(request.method || "GET").toUpperCase();
  let pathname = "";
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    pathname = "";
  }
  const body = typeof request.body === "string" ? request.body : "";
  const gql = /"query"\s*:\s*"\s*(query|mutation|subscription)\b/.exec(body)?.[1] || /^\s*(query|mutation)\b/.exec(body)?.[1];
  if (gql === "mutation" || /mutation/i.test(operationName || "") || /"operationName"\s*:\s*"[^"]*(Create|Delete|Update|Add|Remove|Mutation)/.test(body)) {
    return { side_effect: "write", basis: "GraphQL mutation" };
  }
  if (method === "GET" || method === "HEAD") {
    if (WRITE_PATH.test(pathname)) return { side_effect: "unknown", basis: `${method} to an action-looking path ${pathname}` };
    return { side_effect: "read", basis: `${method} without an action-looking path` };
  }
  if (method === "POST") {
    if (gql === "query") return { side_effect: "read", basis: "GraphQL query" };
    if (READ_PATH.test(pathname) && !WRITE_PATH.test(pathname)) {
      return { side_effect: "read", basis: `POST to a search-like path ${pathname}` };
    }
    if (/persistedQuery/.test(body) && /(Search|Query|Get|List|Fetch)/.test(operationName || "")) {
      return { side_effect: "read", basis: `persisted GraphQL ${operationName}` };
    }
  }
  return { side_effect: "unknown", basis: `${method} ${pathname || "request"} without read evidence` };
}

/** Stable id: origin, method, matcher and name; independent of rotating ids. */
export function operationId(origin, name, match) {
  const digest = createHash("sha256")
    .update(JSON.stringify([origin, name, match?.method || "", match?.host || "", match?.path || "", match?.operationName || ""]))
    .digest("hex")
    .slice(0, 16);
  return `op-${digest}`;
}

/** Param examples a person typed are kept for health checks unless marked private. */
function keptParams(params, privateParams = []) {
  const hidden = new Set(privateParams);
  return params.map((param) => {
    if (!hidden.has(param.name)) return param;
    const { example: _example, ...rest } = param;
    return { ...rest, description: [rest.description, "example not kept (private)"].filter(Boolean).join("; ") };
  });
}

/** A contract from upstream learning output; refs are listed by name only. */
export function contractFromOperation(operation, meta) {
  const origin = new URL(operation.request.url).origin;
  const classified = classifySideEffect(operation.request, {
    operationName: operation.match?.operationName,
    declared: meta.side_effect
  });
  const refs = [
    ...new Set(
      operation.slots.flatMap((slot) => [
        ...(slot.ref ? [slot.ref] : []),
        ...[...(slot.template || "").matchAll(/\{((?:cookie|session):[^{}]+)\}/g)].map((m) => m[1])
      ])
    )
  ].sort();
  return parseContract({
    contract_version: API_CONTRACT_VERSION,
    operation_id: operationId(origin, operation.name, operation.match),
    name: operation.name,
    ...(operation.description || meta.description ? { description: meta.description || operation.description } : {}),
    origin,
    side_effect: classified.side_effect,
    side_effect_basis: classified.basis,
    request: operation.request,
    slots: operation.slots,
    volatile: operation.volatile,
    params: keptParams(operation.params, meta.private_params),
    session_refs: refs,
    session_sources: sessionSources(refs, operation.name, meta.storage || {}),
    ...(operation.public?.length ? { public: operation.public } : {}),
    response: operation.response,
    match: operation.match,
    trigger: operation.trigger,
    min_tier: operation.minTier,
    learned_logged_in: operation.learnedLoggedIn,
    transport: { preference: [1, 2, 3] },
    verification: { status: "unverified", checks: [] },
    provenance: {
      source: meta.source || "two_example_learning",
      engine: ENGINE_ID,
      learned_at: operation.learnedAt || new Date().toISOString(),
      evidence_ids: meta.evidence_ids || [],
      warnings: (meta.warnings || []).map((warning) => String(warning).slice(0, 500)).slice(0, 20),
      ...(meta.parent_operation_id ? { parent_operation_id: meta.parent_operation_id } : {}),
      ...(meta.example_inputs && !(meta.private_params || []).length ? { example_inputs: meta.example_inputs } : {})
    }
  });
}
