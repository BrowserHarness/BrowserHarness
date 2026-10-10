// Health checks and repair for learned API operations. A health check calls a
// read live with an input a person taught it. A repair learns the operation
// again from its page (the same two runs and live third-input check as
// learn_api) and saves the result as a new candidate revision: the active
// revision is never changed, and promotion stays behind the usual gate.
// Repairs are bounded: a few attempts a day per operation, a pause after a
// failed one, and never for writes (a write is re-taught by a person).
import type { ApiLearnInput, ApiLearnOutcome } from "./api-learning";
import { contractDiff, type ApiCallResult, type ApiOperationContract } from "../runtime/api-recipe";

export const MAX_REPAIRS_PER_DAY = 3;
export const REPAIR_COOLDOWN_MS = 60 * 60 * 1000;
export const REPAIR_MIN_GAP_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RepairLedger {
  [operationId: string]: { attempts: Array<{ at: number; outcome: "repaired" | "failed" }> };
}

export interface ApiHealth {
  recipe_id: string;
  operation_id: string;
  passed: boolean;
  class: ApiCallResult["class"] | "skipped";
  tier?: number;
  item_count?: number;
  detail: string;
}

/** The inputs to check or repair with: what a person taught it, else the params' own examples. */
export function taughtInputs(contract: ApiOperationContract): { learning: Array<Record<string, unknown>>; unseen?: Record<string, unknown> } | null {
  const kept = contract.provenance.example_inputs;
  if (kept?.learning?.length) return kept;
  const example = Object.fromEntries(contract.params.filter((param) => param.example !== undefined).map((param) => [param.name, param.example]));
  return Object.keys(example).length || !contract.params.length ? { learning: [example] } : null;
}

export async function checkApiHealth(
  dispatch: (contract: ApiOperationContract, args: Record<string, unknown>) => Promise<ApiCallResult>,
  recipeId: string,
  contract: ApiOperationContract
): Promise<ApiHealth> {
  const base = { recipe_id: recipeId, operation_id: contract.operation_id };
  if (contract.side_effect !== "read") {
    return { ...base, passed: false, class: "skipped", detail: "a write is never sent to check it" };
  }
  const inputs = taughtInputs(contract);
  if (!inputs) return { ...base, passed: false, class: "skipped", detail: "no taught input is kept (a private input); run it with real values instead" };
  const args = inputs.unseen || inputs.learning[0];
  const answer = await dispatch(contract, args);
  const passed = answer.ok && (answer.item_count ?? 0) > 0;
  return {
    ...base,
    passed,
    class: answer.class,
    tier: answer.tier,
    ...(answer.ok ? { item_count: answer.item_count } : {}),
    detail: passed
      ? `answered over tier ${answer.tier} with ${answer.item_count} items`
      : answer.ok
        ? "answered with no items for an input that had some when it was taught"
        : answer.reason || answer.class
  };
}

/** Whether a repair may start now, and if not, when. */
export function repairAllowed(ledger: RepairLedger, operationId: string, now: number): { allowed: true } | { allowed: false; reason: string; retry_after_ms: number } {
  const attempts = (ledger[operationId]?.attempts || []).filter((attempt) => now - attempt.at < DAY_MS);
  const last = attempts.at(-1);
  if (attempts.length >= MAX_REPAIRS_PER_DAY) {
    const oldest = attempts[0].at;
    return { allowed: false, reason: `${MAX_REPAIRS_PER_DAY} repairs in a day already`, retry_after_ms: oldest + DAY_MS - now };
  }
  if (last?.outcome === "failed" && now - last.at < REPAIR_COOLDOWN_MS) {
    return { allowed: false, reason: "the last repair failed; pausing before trying again", retry_after_ms: last.at + REPAIR_COOLDOWN_MS - now };
  }
  if (last && now - last.at < REPAIR_MIN_GAP_MS) {
    return { allowed: false, reason: "a repair ran moments ago", retry_after_ms: last.at + REPAIR_MIN_GAP_MS - now };
  }
  return { allowed: true };
}

export function recordRepair(ledger: RepairLedger, operationId: string, outcome: "repaired" | "failed", now: number): RepairLedger {
  const attempts = [...(ledger[operationId]?.attempts || []).filter((attempt) => now - attempt.at < DAY_MS), { at: now, outcome }];
  const next = { ...ledger, [operationId]: { attempts } };
  // keep the ledger small: operations repaired in the last day only
  return Object.fromEntries(Object.entries(next).filter(([, value]) => value.attempts.some((attempt) => now - attempt.at < DAY_MS)));
}

export interface ApiRepairDeps {
  learn(input: ApiLearnInput): Promise<ApiLearnOutcome>;
  ledger(): Promise<RepairLedger>;
  saveLedger(ledger: RepairLedger): Promise<void>;
  now(): number;
}

export type ApiRepairOutcome =
  | {
      ok: true;
      data: {
        repaired_from: string;
        proposed_revision_id: string;
        recipe_id: string;
        verification: string;
        changes: string[];
        active_revision_unchanged: true;
        promotion: string;
      };
    }
  | { ok: false; error: { code: string; message: string }; data?: Record<string, unknown> };

/**
 * Learn a drifted operation again. `examples` and `verify_args` default to
 * what a person taught it; `page_url` to its trigger page.
 */
export async function repairApiOperation(
  deps: ApiRepairDeps,
  input: {
    skill_id: string;
    recipe_id: string;
    contract: ApiOperationContract;
    examples?: Array<Record<string, unknown>>;
    verify_args?: Record<string, unknown>;
    page_url?: string;
  }
): Promise<ApiRepairOutcome> {
  const { contract } = input;
  if (contract.side_effect !== "read") {
    return { ok: false, error: { code: "API_REPAIR_WRITE", message: "A write is not repaired automatically: teach it again with a demonstration you approve." } };
  }
  const now = deps.now();
  const ledger = await deps.ledger();
  // one ledger entry per operation of a Skill, across the new ids its repairs get
  const key = `${input.skill_id}:${contract.name}`;
  const allowed = repairAllowed(ledger, key, now);
  if (!allowed.allowed) {
    return {
      ok: false,
      error: { code: "API_REPAIR_COOLDOWN", message: `Not repairing ${contract.name} now: ${allowed.reason}.` },
      data: { retry_after_minutes: Math.ceil(allowed.retry_after_ms / 60_000) }
    };
  }
  const taught = taughtInputs(contract);
  const examples = input.examples?.length === 2 ? input.examples : taught?.learning.length === 2 ? taught.learning : undefined;
  const verifyArgs = input.verify_args || taught?.unseen;
  if (!examples || !verifyArgs) {
    return {
      ok: false,
      error: {
        code: "API_REPAIR_INPUT",
        message: `Give two example inputs and a third one to check with (examples, verify_args): ${contract.name} keeps no taught inputs.`
      }
    };
  }
  const learned = await deps.learn({
    name: contract.name,
    page_url: input.page_url || contract.trigger.url,
    examples,
    verify_args: verifyArgs,
    id: input.skill_id,
    ...(contract.description ? { description: contract.description } : {}),
    source: "repair",
    parent_operation_id: contract.operation_id,
    replace_recipe_id: input.recipe_id
  });
  const verified = learned.ok && learned.data.verification.status === "verified";
  await deps.saveLedger(recordRepair(ledger, key, verified ? "repaired" : "failed", now));
  if (!learned.ok) return { ok: false, error: learned.error, data: { repaired_from: contract.operation_id } };
  return {
    ok: true,
    data: {
      repaired_from: contract.operation_id,
      proposed_revision_id: learned.data.revision_id,
      recipe_id: learned.data.recipe_id,
      verification: learned.data.verification.status,
      changes: contractDiff(contract, learned.data.contract),
      active_revision_unchanged: true,
      promotion: verified
        ? "The repaired operation is a new candidate revision; the active one is unchanged. Compare and promote it with site_skill compare and promote."
        : "The repair did not verify; it is saved as a candidate for inspection and will not be promoted."
    }
  };
}

/** What to do next after a failed run, by class. */
export function nextForClass(cls: ApiCallResult["class"], origin: string): string | undefined {
  switch (cls) {
    case "auth":
      return `sign in to ${origin} in this browser, then run it again`;
    case "rate_limited":
      return "the site is limiting requests: wait before running it again";
    case "blocked":
      return `the site blocked the request: open ${origin} in this browser once, then run it again`;
    case "schema_drift":
    case "endpoint_drift":
      return "the site changed: site_skill repair (it learns the operation again as a new candidate revision)";
    case "ambiguous_write":
      return "check the site to see whether it happened; do not run it again";
    default:
      return undefined;
  }
}
