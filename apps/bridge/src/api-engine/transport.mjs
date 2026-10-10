// The Bridge's half of tiers 2 and 3. The extension owns the browser: for
// tier 2 it sends the request the Bridge builds from inside a page of the site
// (with the page's own cookies), for tier 3 it loads the operation's page and
// records what the page sends. The Bridge builds, matches and judges; the same
// classifier and extractor as tier 1, so every tier answers in one shape.
import { BadHeader, buildRequest, ownMatch } from "../../vendor/api-anything/dist/http.js";
import { fillTrigger } from "../../vendor/api-anything/dist/heal.js";
import { matches } from "../../vendor/api-anything/dist/learn.js";
import { loginPath } from "../../vendor/api-anything/dist/classify.js";
import { result } from "./outcome.mjs";
import { toUpstreamOperation } from "./recipe.mjs";
import { resolveSession } from "./session.mjs";
import { INPUT_ERROR, judgeObserved, refusedBeforeSend } from "./tier1.mjs";
import { toCaptureResult } from "./capture.mjs";

// a page's fetch() may not set these, or sets them itself
const PAGE_OWNED = /^(host|cookie|cookie2|content-length|connection|keep-alive|accept-encoding|accept-charset|origin|referer|user-agent|te|trailer|transfer-encoding|upgrade|via|expect|date|dnt|priority|sec-.*|proxy-.*)$/i;

/**
 * Tier 2: the request for a page to send. Cookie references are left to the
 * page (it sends its own cookies); storage references are filled from the
 * storage the extension read in that page. A page-only value still cannot be
 * produced here: that operation needs tier 3.
 */
export function buildForPage(contract, args = {}, { provided, approved = false } = {}) {
  const refused = refusedBeforeSend(contract, 2, { approved });
  if (refused) return { refused };
  const base = { tier: 2, operation_id: contract.operation_id, sent: false };
  if (contract.min_tier > 2) {
    return { refused: result({ ...base, ok: false, cls: "unavailable", reason: `${contract.name} changes per page load; only the page itself can send it (tier 3)` }) };
  }
  const { session, missing, needs_page: needsPage } = resolveSession(contract, provided);
  const missingStorage = missing.filter((ref) => ref.startsWith("session:"));
  if (needsPage || missingStorage.length) {
    return {
      refused: result({
        ...base,
        ok: false,
        cls: "unavailable",
        reason: needsPage ? "a header this operation sends is produced by the page's own script" : "a value this operation sends is not in this page's storage"
      })
    };
  }
  let request;
  try {
    request = buildRequest(toUpstreamOperation(contract), args, session);
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    if (INPUT_ERROR.test(message) || error instanceof BadHeader) return { refused: result({ ...base, ok: false, cls: "input", reason: message }) };
    throw error;
  }
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !PAGE_OWNED.test(name)));
  const get = request.method === "GET" || request.method === "HEAD";
  return {
    request: {
      url: request.url,
      method: request.method,
      headers,
      ...(get || request.body === undefined ? {} : { body: request.body })
    },
    // the page the request must be sent from, for its cookies and CORS
    page_origin: new URL(contract.trigger.url.replace(/\{[^{}]*\}/g, "x")).origin
  };
}

/**
 * Tier 2: judge what the page's fetch answered. `observed.redirected_opaque`
 * is a redirect the page did not follow (fetch redirect: "manual").
 */
export function judgePageAnswer(contract, observed) {
  const base = { tier: 2, operation_id: contract.operation_id, sent: true };
  if (observed?.error) {
    const read = contract.side_effect === "read";
    return result({
      ...base,
      ok: false,
      cls: read ? "network" : "ambiguous_write",
      reason: String(observed.error).slice(0, 300),
      ...(read ? {} : { next: "the write may have run: check the site; do not resend" })
    });
  }
  if (observed?.redirected_opaque) {
    const read = contract.side_effect === "read";
    return result({
      ...base,
      ok: false,
      cls: read ? "endpoint_drift" : "ambiguous_write",
      reason: "the site answered with a redirect, which was not followed",
      next: read ? "teach the operation again" : "the write may have run: check the site; do not resend"
    });
  }
  return judgeObserved(contract, observed, 2);
}

/** Tier 3: the page to load for these args (only a read, and only a page without UI steps for now). */
export function triggerFor(contract, args = {}) {
  const base = { tier: 3, operation_id: contract.operation_id, sent: false };
  if (contract.side_effect !== "read") {
    return { refused: result({ ...base, ok: false, cls: "unavailable", reason: "a write is not replayed through the page; run it with approval at tier 1 or 2" }) };
  }
  if (contract.trigger.steps?.length) {
    return { refused: result({ ...base, ok: false, cls: "unavailable", reason: "this operation's page needs UI steps, which the page tier does not replay yet" }) };
  }
  for (const param of contract.params) {
    if (param.required && args[param.name] === undefined && param.default === undefined) {
      return { refused: result({ ...base, ok: false, cls: "input", reason: `missing required param "${param.name}"` }) };
    }
  }
  const filled = fillTrigger(contract.trigger, Object.fromEntries(contract.params.map((param) => [param.name, args[param.name] ?? param.default]).filter(([, value]) => value !== undefined)));
  return { url: filled.url };
}

/** Tier 3: find this operation's request among what the page sent, and judge its answer. */
export function judgePageRun(contract, capture) {
  const base = { tier: 3, operation_id: contract.operation_id, sent: true };
  const run = toCaptureResult(capture);
  const op = toUpstreamOperation(contract);
  const match = ownMatch(op);
  const hits = run.exchanges.filter((exchange) => matches(match, exchange.request) && exchange.response);
  const hit = hits.at(-1);
  if (!hit) {
    if (run.finalUrl && loginPath(run.finalUrl)) {
      return result({ ...base, ok: false, cls: "auth", reason: "the page went to a sign-in page" });
    }
    return result({
      ...base,
      ok: false,
      cls: "endpoint_drift",
      reason: `the page no longer sends a request matching ${JSON.stringify(match)}`,
      next: "teach the operation again"
    });
  }
  return judgeObserved(contract, { status: hit.response.status, headers: hit.response.headers, body: hit.response.body ?? "", url: hit.request.url }, 3);
}
