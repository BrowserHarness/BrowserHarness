// site_skill learn_api: run a page twice with two example inputs in a
// task-owned background tab, have the Bridge learn the operation from the two
// captures, check it live with a third input neither run used, and save it as
// a candidate revision of a Site Skill. Nothing is promoted here: promotion
// stays an explicit step behind the existing gate.
import type { BridgeRpcResult } from "./bridge-client";
import type { ApiCapture } from "./api-capture";
import {
  isApiContract,
  withApiRecipe,
  apiRecipeFromContract,
  type ApiCallResult,
  type ApiOperationContract,
  type ApiVerificationCheck
} from "../runtime/api-recipe";
import type { SiteCandidateSkill } from "../runtime/site-skill";

export interface ApiLearnInput {
  /** operation name, like "search" */
  name: string;
  /** the page that makes the request, with {param} where each input goes: https://shop.example/search?q={q} */
  page_url: string;
  examples: Array<Record<string, unknown>>;
  /** a third input neither example used; the operation is called live with it */
  verify_args?: Record<string, unknown>;
  side_effect?: "read" | "write";
  /** add the operation to this Site Skill instead of creating one */
  id?: string;
  skill_name?: string;
  description?: string;
  private_params?: string[];
}

export interface ApiLearnDeps {
  runPage(url: string): Promise<ApiCapture>;
  bridge(action: "learn", payload: Record<string, unknown>): Promise<BridgeRpcResult>;
  loadBase(id: string): Promise<{ candidate: SiteCandidateSkill; revision_id: string } | null>;
  save(candidate: SiteCandidateSkill, reason: "create" | "refinement"): Promise<{ revision_id: string }>;
  evaluate(id: string, revisionId: string, entry: { kind: "structural-verification" | "execution"; outcome: "passed" | "failed"; detail: string }): Promise<void>;
  execution(
    id: string,
    revisionId: string,
    entry: { recipe_id: string; started_at: string; outcome: "passed" | "failed"; evidence_id: string; executed_steps: number; submitted: boolean; parameter_names: string[]; error_code?: string; error_message?: string }
  ): Promise<unknown>;
  now(): string;
  newId(): string;
}

export type ApiLearnOutcome =
  | {
      ok: true;
      data: {
        candidate_id: string;
        revision_id: string;
        recipe_id: string;
        operation: Pick<ApiOperationContract, "operation_id" | "name" | "side_effect" | "side_effect_basis" | "params" | "session_refs" | "min_tier">;
        verification: ApiOperationContract["verification"];
        result_preview?: unknown;
        warnings: string[];
        promotion: string;
      };
    }
  | { ok: false; error: { code: string; message: string; details?: string }; data?: Record<string, unknown> };

const fail = (code: string, message: string, extra: Partial<Extract<ApiLearnOutcome, { ok: false }>> = {}): ApiLearnOutcome => ({
  ok: false,
  error: { code, message },
  ...extra
});

/** The page URL for one example; values are percent-encoded into their {name} holes. */
export function fillPageUrl(template: string, args: Record<string, unknown>): string {
  return template.replace(/\{([A-Za-z_][\w-]*)\}/g, (hole, name: string) =>
    args[name] === undefined ? hole : encodeURIComponent(String(args[name]))
  );
}

function plain(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function learnApiOperation(deps: ApiLearnDeps, input: ApiLearnInput): Promise<ApiLearnOutcome> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!/^[A-Za-z][\w-]{0,63}$/.test(name)) {
    return fail("API_LEARN_INPUT", "name the operation with letters, digits, - or _, like \"search\"");
  }
  if (input.side_effect === "write") {
    // a write is learned from what a person does (Watch Me), never by running it twice here
    return fail("API_LEARN_WRITE_REFUSED", "Writes are learned from a demonstration you approve, not by running the page twice. Record it with Watch Me instead.");
  }
  let page: URL;
  try {
    page = new URL(fillPageUrl(String(input.page_url || ""), {}).replace(/\{|\}/g, ""));
  } catch {
    return fail("API_LEARN_INPUT", "page_url must be an http(s) address with {name} where each input goes");
  }
  if (!/^https?:$/.test(page.protocol)) return fail("API_LEARN_INPUT", "page_url must be an http(s) address");
  const examples = Array.isArray(input.examples) ? input.examples.filter(plain) : [];
  if (examples.length !== 2) return fail("API_LEARN_INPUT", "give two examples with different values, like [{\"q\":\"laptops\"},{\"q\":\"keyboards\"}]");
  const holes = [...String(input.page_url).matchAll(/\{([A-Za-z_][\w-]*)\}/g)].map((match) => match[1]);
  const missing = Object.keys(examples[0]).filter((key) => !holes.includes(key));
  if (missing.length) return fail("API_LEARN_INPUT", `page_url has no {${missing[0]}}: put it where that input goes in the address`);
  if (!plain(input.verify_args) || !Object.keys(input.verify_args).length) {
    return fail("API_LEARN_INPUT", "give verify_args: a third input neither example used, so the operation can be checked live");
  }

  const evidenceId = `api-${deps.newId()}`;
  const startedAt = deps.now();
  let captures: ApiCapture[];
  try {
    captures = [];
    for (const example of examples) captures.push(await deps.runPage(fillPageUrl(input.page_url, example)));
  } catch (error) {
    return fail("API_LEARN_RUN_FAILED", error instanceof Error ? error.message : "The page could not be run");
  }

  const base = input.id ? await deps.loadBase(input.id) : null;
  if (input.id && !base) return fail("SITE_SKILL_NOT_FOUND", "Site Skill candidate was not found");

  const learned = await deps.bridge("learn", {
    name,
    captures,
    examples,
    trigger: { url: input.page_url },
    verify_args: input.verify_args,
    ...(input.side_effect ? { side_effect: input.side_effect } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.private_params ? { private_params: input.private_params } : {}),
    evidence_ids: [evidenceId],
    source: "two_example_learning"
  });
  // the captures held cookies and storage: drop them now
  captures.length = 0;
  if (!learned.ok) {
    return { ok: false, error: learned.error || { code: "API_ENGINE_FAILED", message: "Learning failed" } };
  }
  const data = learned.data as { contract?: unknown; warnings?: string[]; verification?: ApiVerificationCheck; verification_response?: ApiCallResult };
  if (!isApiContract(data?.contract)) return fail("API_ENGINE_FAILED", "The helper app returned no operation contract");
  const contract = data.contract;

  let candidate: SiteCandidateSkill;
  try {
    candidate = withApiRecipe(base?.candidate || null, {
      contract,
      entry_url: page.origin + page.pathname,
      title: input.skill_name || page.hostname,
      ...(input.skill_name ? { name: input.skill_name } : {}),
      evidence_id: evidenceId,
      captured_at: startedAt
    });
  } catch (error) {
    return fail("SITE_SKILL_ORIGIN_MISMATCH", error instanceof Error ? error.message : "The operation is on another site");
  }
  const recipeId = apiRecipeFromContract(contract, candidate.site.entry_url).id;
  const saved = await deps.save(candidate, base ? "refinement" : "create");
  const verified = contract.verification.status === "verified";
  const check = data.verification;
  await deps.evaluate(candidate.id, saved.revision_id, {
    kind: "structural-verification",
    outcome: verified ? "passed" : "failed",
    detail: verified
      ? `API contract ${contract.operation_id}: both learning runs and an unseen input answered`
      : `API contract ${contract.operation_id} did not verify: ${check?.detail || contract.verification.status}`
  });
  if (check?.class) {
    // the unseen-input call was a real, live call of the recipe
    await deps.evaluate(candidate.id, saved.revision_id, {
      kind: "execution",
      outcome: check.passed ? "passed" : "failed",
      detail: `unseen input over tier ${check.tier ?? "?"}: ${check.passed ? `${check.item_count ?? 0} items` : check.detail || check.class}`
    });
    await deps.execution(candidate.id, saved.revision_id, {
      recipe_id: recipeId,
      started_at: startedAt,
      outcome: check.passed ? "passed" : "failed",
      evidence_id: evidenceId,
      executed_steps: 1,
      submitted: false,
      parameter_names: Object.keys(input.verify_args).sort(),
      ...(check.passed ? {} : { error_code: `API_${String(check.class).toUpperCase()}`, error_message: check.detail || check.class })
    });
  }

  return {
    ok: true,
    data: {
      candidate_id: candidate.id,
      revision_id: saved.revision_id,
      recipe_id: recipeId,
      operation: {
        operation_id: contract.operation_id,
        name: contract.name,
        side_effect: contract.side_effect,
        side_effect_basis: contract.side_effect_basis,
        params: contract.params,
        session_refs: contract.session_refs,
        min_tier: contract.min_tier
      },
      verification: contract.verification,
      ...(data.verification_response?.ok ? { result_preview: data.verification_response.data } : {}),
      warnings: Array.isArray(data.warnings) ? data.warnings : [],
      promotion: verified
        ? "Saved as a candidate. Promote it with site_skill promote once you are happy with it."
        : "Saved as a candidate that did not verify; it will not be promoted until it does."
    }
  };
}
