// The Bridge's half of tiers 2 and 3. The extension owns the browser: for
// tier 2 it sends the request the Bridge builds from inside a page of the site
// (with the page's own cookies), for tier 3 it loads the operation's page and
// records what the page sends. The Bridge builds, matches and judges; the same
// classifier and extractor as tier 1, so every tier answers in one shape.
import { BadHeader, buildRequest, holdsRef, ownMatch } from "../../vendor/api-anything/dist/http.js";
import { asText, getAt } from "../../vendor/api-anything/dist/codec.js";
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
  const refused = refusedBeforeSend(contract, 2, { approved, args });
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

const PAGE_HEADERS = new Set(["referer", "origin"]);
const URL_TEMPLATE = /^([a-z][a-z0-9+.-]*:\/\/|\/)\S*$/i;

/**
 * A header slot that mirrors the page's address: referer, origin, or a
 * header whose learned template is itself an address (a site's own
 * x-...-url). An app may write those differently from the trigger URL (an
 * extra &sort=, another order), so they are not compared character for
 * character. Any other header slot is a real input and is compared.
 */
function mirrorsPage(slot) {
  const [at] = slot.at;
  if (!at.startsWith("header:")) return false;
  return PAGE_HEADERS.has(at.slice("header:".length).toLowerCase()) || (typeof slot.template === "string" && URL_TEMPLATE.test(slot.template));
}

/** Whether an address names this value as a whole query value or path segment. */
function addressNames(text, value) {
  let url;
  try {
    url = new URL(String(text), "http://page.invalid");
  } catch {
    return false;
  }
  const want = asText(value);
  const decode = (part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  return [...url.searchParams.values()].some((item) => item === want) || url.pathname.split("/").some((segment) => decode(segment) === want);
}

/**
 * Whether an observed request carries these inputs. Every input slot that is
 * not a mirror of the page's address must hold exactly the value these args
 * put there. Every param must be proven by at least one slot: a param that
 * only a page-address header carries is checked there (the address must name
 * the value). Slots that also carry a session reference are not compared
 * (their values are the page's own). Anything that cannot be checked fails.
 */
export function carriesArgs(op, observed, args) {
  let expected;
  try {
    // the inputs only: session values are left out (an empty session drops
    // them), so an operation that holds one is still recognised (RC3: every
    // signed-in or token request was reported as endpoint_drift)
    expected = buildRequest(op, args, { cookies: [], storage: {}, values: {} });
  } catch {
    return false;
  }
  const read = (request, at) => {
    try {
      return { value: getAt(request, at) };
    } catch {
      return null;
    }
  };
  const inputSlots = op.slots.filter((slot) => slot.param !== undefined && !holdsRef(slot));
  const proven = new Set();
  // a slot whose template also holds a session value ("Bearer {token}:{q}"):
  // the expected text lacks it, so the input is looked for inside the value
  const withSession = (slot) =>
    typeof slot.template === "string" &&
    [...slot.template.matchAll(/\{([^}]+)\}/g)].some(([, name]) => name !== slot.param && !op.params.some((param) => param.name === name));
  for (const slot of inputSlots.filter((item) => !mirrorsPage(item))) {
    const got = read(observed, slot.at);
    if (withSession(slot)) {
      const value = args[slot.param];
      if (value === undefined) continue;
      const text = got?.value === undefined ? "" : asText(got.value);
      if (!text.includes(asText(value)) && !text.includes(encodeURIComponent(asText(value)))) return false;
      proven.add(slot.param);
      continue;
    }
    const want = read(expected, slot.at);
    if (!want || !got) return false;
    if (want.value === undefined) continue;
    if (got.value === undefined || asText(got.value) !== asText(want.value)) return false;
    proven.add(slot.param);
  }
  for (const param of op.params) {
    if (proven.has(param.name) || args[param.name] === undefined) continue;
    const mirrors = inputSlots.filter((slot) => slot.param === param.name && mirrorsPage(slot));
    if (!mirrors.length) return false;
    for (const slot of mirrors) {
      const got = read(observed, slot.at);
      if (!got || got.value === undefined || !addressNames(got.value, args[param.name])) return false;
    }
    proven.add(param.name);
  }
  // an operation with inputs must show them in the request
  return op.params.every((param) => proven.has(param.name) || args[param.name] === undefined) && (proven.size > 0 || !op.params.length);
}

/**
 * Hosts of one load-balanced service: Algolia answers the same app from
 * APPID-dsn.algolia.net and APPID-N.algolianet.com and a page moves between
 * them. Siblings share an app-id-like first label (letters and digits, 6 or
 * more) up to a -dsn or -N suffix, and a domain name that starts the same.
 * Only tier 3 uses this, to recognise the page's own request; nothing is sent
 * to a sibling.
 */
export function siblingHosts(a, b) {
  const left = String(a || "").toLowerCase();
  const right = String(b || "").toLowerCase();
  if (left === right) return true;
  const split = (host) => {
    const labels = host.split(".");
    return { stem: labels[0].replace(/-(dsn|\d{1,2})$/, ""), domain: labels.slice(1, -1).join(".") || labels.at(-1) };
  };
  const one = split(left);
  const two = split(right);
  if (one.stem !== two.stem || !/^[a-z0-9]{6,}$/.test(one.stem) || !/\d/.test(one.stem) || !/[a-z]/.test(one.stem)) return false;
  const prefix = (x, y) => {
    let index = 0;
    while (index < x.length && x[index] === y[index]) index++;
    return index;
  };
  return prefix(one.domain, two.domain) >= 5;
}

/** The learned request's match, its host or a sibling of it. */
function matchesService(match, request) {
  if (!matches({ ...match, host: undefined }, request)) return false;
  if (!match.host) return true;
  try {
    return siblingHosts(match.host, new URL(request.url).hostname);
  } catch {
    return false;
  }
}

/** Tier 3: find this operation's request for these args among what the page sent, and judge its answer. */
export function judgePageRun(contract, capture, args) {
  const base = { tier: 3, operation_id: contract.operation_id, sent: true };
  const run = toCaptureResult(capture);
  const op = toUpstreamOperation(contract);
  const match = ownMatch(op);
  const hits = run.exchanges.filter((exchange) => matchesService(match, exchange.request) && exchange.response);
  if (!args || typeof args !== "object") {
    return result({ ...base, ok: false, cls: "input", reason: "the page tier needs the inputs to check the page's request against" });
  }
  const hit = hits.filter((exchange) => carriesArgs(op, exchange.request, args)).at(-1);
  if (!hit && hits.length) {
    // the page made the request, but not with these inputs: never answer with
    // another request's data. A page often sends its default query first and
    // the one with the inputs a moment later: the caller keeps watching while
    // it can (awaiting_request) and reports this only when the time is up.
    return {
      ...result({
        ...base,
        ok: false,
        cls: "endpoint_drift",
        reason: "the page's request did not carry the inputs given (it ignored them or sent its own default)",
        next: "teach the operation again"
      }),
      awaiting_request: true
    };
  }
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
