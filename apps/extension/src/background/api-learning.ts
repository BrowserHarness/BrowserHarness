// site_skill learn_api: run a page twice with two example inputs in a
// task-owned background tab, have the Bridge learn the operation from the two
// captures, check it live with a third input neither run used, and save it as
// a candidate revision of a Site Skill. Nothing is promoted here: promotion
// stays an explicit step behind the existing gate.
import type { BridgeRpcResult } from "./bridge-client";
import type { ApiCapture } from "./api-capture";
import type { WatchApiCapture } from "./api-watch";
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
  /** set by repair: the operation this one replaces */
  source?: "two_example_learning" | "repair";
  parent_operation_id?: string;
  replace_recipe_id?: string;
  /** learn from one or two Watch Me recordings instead of running the page */
  from_watch?: string[];
}

export interface ApiLearnDeps {
  runPage(url: string): Promise<ApiCapture>;
  bridge(action: "learn" | "verify", payload: Record<string, unknown>): Promise<BridgeRpcResult>;
  /** runs the learned operation by tier (hybrid dispatcher), for the live unseen-input check */
  dispatch(contract: ApiOperationContract, args: Record<string, unknown>): Promise<ApiCallResult>;
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
  /** a Watch Me recording's kept capture */
  watchCapture?(recordingId: string): WatchApiCapture | null;
  forgetWatch?(recordingId: string): void;
}

export type ApiLearnOutcome =
  | {
      ok: true;
      data: {
        candidate_id: string;
        revision_id: string;
        recipe_id: string;
        operation: Pick<ApiOperationContract, "operation_id" | "name" | "side_effect" | "side_effect_basis" | "params" | "session_refs" | "min_tier">;
        contract: ApiOperationContract;
        verification: ApiOperationContract["verification"];
        result_preview?: unknown;
        answered_by_tier?: number;
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
  if (Array.isArray(input.from_watch) && input.from_watch.length) return learnFromWatch(deps, { ...input, name });
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

  return learnAndSave(deps, input, {
    name,
    captures,
    examples,
    trigger_url: input.page_url,
    entry_url: page.origin + page.pathname,
    hostname: page.hostname,
    evidence_id: evidenceId,
    started_at: startedAt,
    source: input.source === "repair" ? "repair" : "two_example_learning",
    verify_args: input.verify_args
  });
}

/**
 * Learn from Watch Me: the recordings' own captures stand in for the two page
 * runs, and the typed values are the examples. A write is allowed here (the
 * person did it); it stays unverified, since a write is never sent to check
 * it, and every run of it asks first.
 */
async function learnFromWatch(deps: ApiLearnDeps, input: ApiLearnInput): Promise<ApiLearnOutcome> {
  const ids = (input.from_watch || []).map(String).slice(0, 3);
  if (ids.length > 2) return fail("API_LEARN_INPUT", "give one or two Watch Me recordings in from_watch");
  if (!deps.watchCapture) return fail("API_LEARN_WATCH_MISSING", "Watch Me captures are not available here");
  const kept = ids.map((id) => deps.watchCapture!(id));
  const lost = ids.find((_, index) => !kept[index]);
  if (lost) {
    return fail("API_LEARN_WATCH_MISSING", `No network capture is kept for recording ${lost}: they are kept for 15 minutes after Watch Me stops, in memory only. Record it again.`);
  }
  const recordings = kept as WatchApiCapture[];
  let examples: Array<Record<string, unknown>>;
  if (Array.isArray(input.examples) && input.examples.length) {
    examples = input.examples.filter(plain);
    if (examples.length !== recordings.length) return fail("API_LEARN_INPUT", "give one example per recording, or leave examples out to use what was typed");
  } else {
    const shared = Object.keys(recordings[0].examples).filter((key) => recordings.every((item) => item.examples[key] !== undefined));
    // with two recordings, the inputs are the fields typed differently
    const names = recordings.length === 2 ? shared.filter((key) => recordings[0].examples[key].toLowerCase() !== recordings[1].examples[key].toLowerCase()) : shared;
    if (!names.length) {
      return fail(
        "API_LEARN_INPUT",
        recordings.length === 2
          ? "the two recordings typed nothing different; record again with a different value, or give examples"
          : "the recording typed nothing to learn an input from; give examples with the values it used"
      );
    }
    examples = recordings.map((item) => Object.fromEntries(names.map((key) => [key, item.examples[key]])));
  }
  let entry: URL;
  try {
    entry = new URL(fillPageUrl(String(input.page_url || recordings[0].start_url), {}).replace(/\{|\}/g, ""));
  } catch {
    return fail("API_LEARN_INPUT", "page_url must be an http(s) address");
  }
  const write = input.side_effect === "write";
  if (!write && input.verify_args !== undefined && (!plain(input.verify_args) || !Object.keys(input.verify_args).length)) {
    return fail("API_LEARN_INPUT", "verify_args must name the same inputs as the examples");
  }
  const outcome = await learnAndSave(deps, input, {
    name: input.name,
    captures: recordings.map((item) => item.capture),
    examples,
    ...(input.page_url ? { trigger_url: input.page_url } : {}),
    entry_url: entry.origin + entry.pathname,
    hostname: entry.hostname,
    evidence_id: `watch-${ids[0]}`,
    started_at: deps.now(),
    source: "watch_me",
    ...(plain(input.verify_args) && !write ? { verify_args: input.verify_args } : {}),
    // what a person typed into a write is theirs: keep no example values for it
    ...(write && !input.private_params ? { private_params: Object.keys(examples[0]) } : {})
  });
  if (outcome.ok) for (const id of ids) deps.forgetWatch?.(id);
  return outcome;
}

interface LearnRun {
  name: string;
  captures: ApiCapture[];
  examples: Array<Record<string, unknown>>;
  trigger_url?: string;
  entry_url: string;
  hostname: string;
  evidence_id: string;
  started_at: string;
  source: "two_example_learning" | "repair" | "watch_me";
  verify_args?: Record<string, unknown>;
  private_params?: string[];
}

async function learnAndSave(deps: ApiLearnDeps, input: ApiLearnInput, run: LearnRun): Promise<ApiLearnOutcome> {
  const { name, examples } = run;
  const evidenceId = run.evidence_id;
  const startedAt = run.started_at;
  const base = input.id ? await deps.loadBase(input.id) : null;
  if (input.id && !base) return fail("SITE_SKILL_NOT_FOUND", "Site Skill candidate was not found");

  const privateParams = input.private_params || run.private_params;
  const learned = await deps.bridge("learn", {
    name,
    captures: run.captures,
    examples,
    ...(run.trigger_url ? { trigger: { url: run.trigger_url } } : {}),
    ...(input.side_effect ? { side_effect: input.side_effect } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(privateParams ? { private_params: privateParams } : {}),
    evidence_ids: [evidenceId],
    source: run.source,
    ...(input.parent_operation_id ? { parent_operation_id: input.parent_operation_id } : {})
  });
  if (!learned.ok) {
    return { ok: false, error: learned.error || { code: "API_ENGINE_FAILED", message: "Learning failed" } };
  }
  const data = learned.data as { contract?: unknown; warnings?: string[]; example_fingerprints?: string[] };
  if (!isApiContract(data?.contract)) return fail("API_ENGINE_FAILED", "The helper app returned no operation contract");

  // the unseen input, live, through the same tiers a run uses (a signed-in read
  // answers in the page); never for a write, which is not sent to check it
  const verifyArgs = data.contract.side_effect === "read" ? run.verify_args : undefined;
  let contract: ApiOperationContract = data.contract;
  let check: ApiVerificationCheck | undefined;
  let response: ApiCallResult | undefined;
  if (verifyArgs) {
    response = await deps.dispatch(data.contract, verifyArgs);
    const checked = await deps.bridge("verify", {
      contract: data.contract,
      args: verifyArgs,
      examples,
      example_fingerprints: data.example_fingerprints || [],
      response
    });
    if (!checked.ok) return { ok: false, error: checked.error || { code: "API_ENGINE_FAILED", message: "Verification failed" } };
    const verifiedData = checked.data as { contract?: unknown; check?: ApiVerificationCheck };
    if (!isApiContract(verifiedData?.contract)) return fail("API_ENGINE_FAILED", "The helper app returned no operation contract");
    contract = verifiedData.contract;
    check = verifiedData.check;
  }

  let candidate: SiteCandidateSkill;
  try {
    candidate = withApiRecipe(base?.candidate || null, {
      contract,
      entry_url: run.entry_url,
      title: input.skill_name || run.hostname,
      ...(input.skill_name ? { name: input.skill_name } : {}),
      evidence_id: evidenceId,
      captured_at: startedAt,
      ...(input.replace_recipe_id ? { replace_recipe_id: input.replace_recipe_id } : {})
    });
  } catch (error) {
    return fail("SITE_SKILL_ORIGIN_MISMATCH", error instanceof Error ? error.message : "The operation is on another site");
  }
  const recipeId = apiRecipeFromContract(contract, candidate.site.entry_url).id;
  const saved = await deps.save(candidate, base ? "refinement" : "create");
  const verified = contract.verification.status === "verified";
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
      parameter_names: Object.keys(verifyArgs || {}).sort(),
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
      contract,
      verification: contract.verification,
      ...(response?.ok ? { result_preview: response.data, answered_by_tier: response.tier } : {}),
      warnings: Array.isArray(data.warnings) ? data.warnings : [],
      promotion: verified
        ? "Saved as a candidate. Promote it with site_skill promote once you are happy with it."
        : contract.side_effect === "write"
          ? "Saved as an unverified candidate: a write is never sent to check it, and every run of it asks you first."
          : verifyArgs
            ? "Saved as a candidate that did not verify; it will not be promoted until it does."
            : "Saved as an unverified candidate: give verify_args (an input the demonstration did not use) to check it live."
    }
  };
}
