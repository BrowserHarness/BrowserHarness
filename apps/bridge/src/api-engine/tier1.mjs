// Tier 1: a learned operation sent as plain HTTP from the Bridge, with the
// session values the extension handed over for this call only. Always a live
// request: nothing here returns a stored or example response.
import { judge, loginPath, signInForm } from "../../vendor/api-anything/dist/classify.js";
import { capOutput } from "../../vendor/api-anything/dist/extract.js";
import { BadHeader, RedirectRefused, send } from "../../vendor/api-anything/dist/http.js";
import { bhClass, result, structuredResponse } from "./outcome.mjs";
import { toUpstreamOperation } from "./recipe.mjs";
import { resolveSession } from "./session.mjs";

export const INPUT_ERROR = /^(missing required param|param ")/;
const WRITE_NEXT = "the write may have run: check the site; do not resend";

/**
 * What a tier refuses before anything is sent: no approval for a write, a
 * value only a page can produce. `sent: false` lets the dispatcher try another
 * tier, even for a write.
 */
export function refusedBeforeSend(contract, tier, { approved, args = {} }) {
  const base = { tier, operation_id: contract.operation_id, sent: false };
  if (contract.side_effect !== "read") {
    const target = contract.target;
    if (!target && !contract.params.length) {
      return result({
        ...base,
        ok: false,
        cls: "input",
        reason: `${contract.name} takes no inputs and its target (what it acts on) was not recorded when it was learned, so it cannot be sent safely; teach it again from a demonstration`
      });
    }
    const given = Object.keys(args || {}).filter((key) => args[key] !== undefined);
    if (target?.kind === "fixed" && given.length) {
      const named = target.fields.map((field) => field.value).join(", ") || target.request;
      return result({
        ...base,
        ok: false,
        cls: "input",
        reason: `${contract.name} always acts on what it was learned on (${named}); it takes no inputs, so it cannot act on ${given.join(", ")}. Teach it again with that value as an input to act on other items`
      });
    }
  }
  if (contract.side_effect !== "read" && !approved) {
    return result({
      ...base,
      ok: false,
      cls: "approval_required",
      reason: `${contract.name} may change data on ${contract.origin} (${contract.side_effect}: ${contract.side_effect_basis}); it needs the person's approval`
    });
  }
  return undefined;
}

// what a server says when the session is missing, on a page shown instead of the data
const SIGN_IN_SAID = /(log|sign) ?in to continue|please (log|sign) ?in|login_required|"require_login"\s*:\s*true|session (has )?expired/i;

/**
 * A read learned from a whole page (no recipe for its data) proves nothing
 * when it answers: the page is "something" signed in or out. Never ok, at any
 * tier: a sign-in page is auth, anything else says what to teach instead.
 */
function wholePageAnswer(contract, observed, base) {
  const body = String(observed.body ?? "");
  if ((observed.url && loginPath(observed.url)) || signInForm(body) || SIGN_IN_SAID.test(body.slice(0, 200_000))) {
    return result({ ...base, ok: false, cls: "auth", reason: "the site answered with a sign-in page: sign in on the site" });
  }
  return result({
    ...base,
    ok: false,
    cls: "unavailable",
    reason: `${contract.name} answers with a whole page (HTML), not data, so its answer cannot be checked; teach it again and pick the request that returns the data`,
    next: "teach the operation again"
  });
}

/** Classify and extract an answer, whichever tier observed it. */
export function judgeObserved(contract, observed, tier, { maxChars = 20_000 } = {}) {
  const op = toUpstreamOperation(contract);
  const base = { tier, operation_id: contract.operation_id, sent: true, status: observed.status, ms: observed.ms };
  if (contract.side_effect === "read" && !structuredResponse(contract.response)) return wholePageAnswer(contract, observed, base);
  const judged = judge(op, { status: observed.status, headers: observed.headers || {}, body: observed.body ?? "", url: observed.url });
  const cls = bhClass(judged.class, { status: observed.status, missing: judged.missing, sideEffect: contract.side_effect, sent: true });
  if (cls !== "ok") {
    return result({ ...base, ok: false, cls, reason: judged.reason, ...(cls === "ambiguous_write" ? { next: WRITE_NEXT } : {}) });
  }
  const capped = capOutput(judged.data, maxChars);
  return result({ ...base, ok: true, cls, data: capped.data, truncated: capped.truncated });
}

/**
 * `provided`: {cookies, storage} the extension read for this call. `approved`:
 * the person approved this write; a write without it is never sent.
 */
export async function callTier1(contract, args = {}, { provided, approved = false, fetchImpl, minIntervalMs, timeoutMs, maxChars = 20_000 } = {}) {
  const base = { tier: 1, operation_id: contract.operation_id, sent: false };
  const refused = refusedBeforeSend(contract, 1, { approved, args });
  if (refused) return refused;
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
      const read = contract.side_effect === "read";
      return result({
        ...base,
        sent: true,
        ok: false,
        cls: read ? "endpoint_drift" : "ambiguous_write",
        reason: message,
        next: read ? "teach the operation again" : WRITE_NEXT
      });
    }
    // a thrown fetch never answered; for a write it may still have arrived
    const cls = bhClass("error", { sideEffect: contract.side_effect });
    return result({ ...base, sent: true, ok: false, cls, reason: message, ...(cls === "ambiguous_write" ? { next: WRITE_NEXT } : {}) });
  }
  return judgeObserved(contract, sent, 1, { maxChars });
}
