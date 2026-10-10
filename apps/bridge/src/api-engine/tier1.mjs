// Tier 1: a learned operation sent as plain HTTP from the Bridge, with the
// session values the extension handed over for this call only. Always a live
// request: nothing here returns a stored or example response.
import { judge } from "../../vendor/api-anything/dist/classify.js";
import { capOutput } from "../../vendor/api-anything/dist/extract.js";
import { BadHeader, RedirectRefused, send } from "../../vendor/api-anything/dist/http.js";
import { bhClass, result } from "./outcome.mjs";
import { toUpstreamOperation } from "./recipe.mjs";
import { resolveSession } from "./session.mjs";

const INPUT_ERROR = /^(missing required param|param ")/;

/**
 * `provided`: {cookies, storage} the extension read for this call. `approved`:
 * the person approved this write; a write without it is never sent.
 */
export async function callTier1(contract, args = {}, { provided, approved = false, fetchImpl, minIntervalMs, timeoutMs, maxChars = 20_000 } = {}) {
  const base = { tier: 1, operation_id: contract.operation_id };
  if (contract.side_effect !== "read" && !approved) {
    return result({
      ...base,
      ok: false,
      cls: "approval_required",
      reason: `${contract.name} may change data on ${contract.origin} (${contract.side_effect}: ${contract.side_effect_basis}); it needs the person's approval`
    });
  }
  if (contract.min_tier > 1) {
    return result({ ...base, ok: false, cls: "unavailable", reason: `${contract.name} changes per page load (min tier ${contract.min_tier}); plain HTTP cannot send it` });
  }
  const { session, missing, needs_page: needsPage } = resolveSession(contract, provided);
  if (needsPage) {
    return result({ ...base, ok: false, cls: "unavailable", reason: "a header this operation sends is produced by the page's own script; run it in the page" });
  }
  if (missing.length) {
    return result({
      ...base,
      ok: false,
      cls: "auth",
      reason: `no value for ${missing.map((ref) => ref.split(":")[0]).join(", ")} reference(s); sign in on ${contract.origin} or run it in the page`
    });
  }
  const op = toUpstreamOperation(contract);
  let sent;
  try {
    sent = await send(op, args, session, {
      site: new URL(contract.origin).host,
      ...(fetchImpl ? { fetchImpl } : {}),
      ...(minIntervalMs !== undefined ? { minIntervalMs } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {})
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    if (INPUT_ERROR.test(message) || error instanceof BadHeader) {
      return result({ ...base, ok: false, cls: "input", reason: message });
    }
    if (error instanceof RedirectRefused) {
      return result({
        ...base,
        ok: false,
        cls: contract.side_effect === "read" ? "endpoint_drift" : "ambiguous_write",
        reason: message,
        next: contract.side_effect === "read" ? "teach the operation again" : "the write may have run: check the site; do not resend"
      });
    }
    // a thrown fetch never answered; for a write it may still have arrived
    const cls = bhClass("error", { sideEffect: contract.side_effect });
    return result({
      ...base,
      ok: false,
      cls,
      reason: message,
      ...(cls === "ambiguous_write" ? { next: "the write may have run: check the site; do not resend" } : {})
    });
  }
  const judged = judge(op, sent);
  const cls = bhClass(judged.class, { status: sent.status, missing: judged.missing, sideEffect: contract.side_effect, sent: true });
  if (cls !== "ok") {
    return result({ ...base, ok: false, cls, status: sent.status, ms: sent.ms, reason: judged.reason });
  }
  const capped = capOutput(judged.data, maxChars);
  return result({ ...base, ok: true, cls, status: sent.status, ms: sent.ms, data: capped.data, truncated: capped.truncated });
}
