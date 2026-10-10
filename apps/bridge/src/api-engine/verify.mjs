// Unseen-input verification: a learned read operation is called live with a
// third input neither run used. It passes only when the call succeeds, finds
// items, and returns data that differs from both learning runs, so a recipe
// that ignores its input (or replays a cached answer) cannot pass.
import { dataFingerprint } from "./outcome.mjs";
import { parseContract } from "./recipe.mjs";
import { callTier1 } from "./tier1.mjs";

function sameValues(a, b) {
  return Object.keys(a).every((key) => String(a[key]).toLowerCase() === String(b?.[key] ?? "").toLowerCase());
}

/**
 * contract: a learned contract. args: the unseen input. examples: the learning
 * inputs (to refuse a repeat). example_fingerprints: digests of the learning
 * runs' data. call: the transport (tier 1 by default; the extension passes a
 * tier-2 result in when a page has to send it).
 */
export async function verifyUnseenInput(contractInput, args, { examples = [], example_fingerprints: fingerprints = [], provided, call, response: given, fetchImpl, minIntervalMs } = {}) {
  const contract = parseContract(contractInput);
  const checkedAt = new Date().toISOString();
  const argNames = Object.keys(args || {});
  const check = (passed, detail, extra = {}) => ({
    kind: "unseen_input",
    passed,
    arg_names: argNames,
    ...(detail ? { detail: String(detail).slice(0, 500) } : {}),
    checked_at: checkedAt,
    ...extra
  });
  let outcome;
  if (contract.side_effect !== "read") {
    outcome = { check: check(false, "a write is never sent to check it; it stays a candidate until a person runs it with approval") };
  } else if (!argNames.length) {
    outcome = { check: check(false, "no unseen input was given") };
  } else if (examples.some((example) => sameValues(args, example))) {
    outcome = { check: check(false, "the third input repeats a learning example; give a value neither run used") };
  } else {
    // `given`: the extension already ran it (tier 2 or 3, through the dispatcher)
    const response = given || (call ? await call(contract, args) : await callTier1(contract, args, { provided, fetchImpl, minIntervalMs }));
    const extra = { tier: response.tier, class: response.class, ...(response.ok ? { item_count: response.item_count } : {}) };
    if (!response.ok) {
      outcome = { check: check(false, response.reason || response.class, extra), response };
    } else if (!response.item_count) {
      outcome = { check: check(false, "the call succeeded but found nothing for this input", extra), response };
    } else if (fingerprints.includes(dataFingerprint(response.data))) {
      outcome = { check: check(false, "the answer equals a learning run's answer: the input is not reaching the request", extra), response };
    } else {
      outcome = { check: check(true, undefined, extra), response };
    }
  }
  const examplesPassed = contract.verification.checks.filter((item) => item.kind === "learned_examples").every((item) => item.passed);
  const verified = {
    ...contract,
    verification: {
      status: outcome.check.passed && examplesPassed ? "verified" : "failed",
      checks: [...contract.verification.checks.filter((item) => item.kind !== "unseen_input"), outcome.check]
    },
    transport:
      outcome.check.passed && outcome.response?.tier
        ? { ...contract.transport, learned_tier: outcome.response.tier }
        : contract.transport
  };
  if (contract.side_effect !== "read") verified.verification.status = "unverified";
  return { contract: parseContract(verified), check: outcome.check, ...(outcome.response ? { response: outcome.response } : {}) };
}
