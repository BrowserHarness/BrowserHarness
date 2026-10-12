// Deterministic two-example learning: two runs of the same page with two
// different example inputs, then upstream's learner (vendored) finds the
// request carrying the inputs, its param slots, session refs, nonces and
// response recipe. No LLM. The result is an API Recipe v2 contract that is
// unverified until an unseen third input succeeds (verify.mjs).
import { botWall, judge, loginPath, signInForm } from "../../vendor/api-anything/dist/classify.js";
import { templatizeUrl } from "../../vendor/api-anything/dist/heal.js";
import { capturePages, checkExamples, learnOperation, operationNameOf, rankCandidates } from "../../vendor/api-anything/dist/learn.js";
import { credentialName, highEntropy, leafName, opaqueToken, scanSecrets } from "../../vendor/api-anything/dist/secrets.js";
import { holdsRef } from "../../vendor/api-anything/dist/http.js";
import { walk } from "../../vendor/api-anything/dist/codec.js";
import { loggedIn } from "../../vendor/api-anything/dist/session.js";
import { toCaptureResult } from "./capture.mjs";
import { dataFingerprint, itemCount, structuredResponse } from "./outcome.mjs";
import { classifySideEffect, contractFromOperation, toUpstreamOperation } from "./recipe.mjs";

const NAME = /^[A-Za-z][\w-]{0,63}$/;

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function plainArgs(args, label, { allowEmpty = false } = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args) || (!allowEmpty && !Object.keys(args).length)) {
    throw fail("API_LEARN_INPUT", `${label} must name at least one input, like {"query": "laptops"}`);
  }
  return args;
}

/** Where a request went, without its query or body (those can hold inputs or tokens). */
function where(exchange) {
  try {
    const url = new URL(exchange.request.url);
    return { id: exchange.id, method: exchange.request.method, url: `${url.origin}${url.pathname}`, status: exchange.response?.status };
  } catch {
    return { id: exchange.id, method: exchange.request.method };
  }
}

/**
 * "POST https://host/path", and "POST https://host/path #Profile" for a
 * GraphQL operation: how a person or agent names a captured request, the same
 * on every run of the page. Several GraphQL operations share one address, so
 * the operation's name is part of it.
 */
function requestName(method, url, operationName) {
  try {
    const parsed = new URL(url);
    return `${String(method).toUpperCase()} ${parsed.origin}${parsed.pathname}${operationName ? ` #${operationName}` : ""}`;
  } catch {
    return "";
  }
}

const nameOf = (exchange) => requestName(exchange.request.method, exchange.request.url, operationNameOf(exchange.request));

function fnv(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * A capture with ids that name the same request on every run of the page: a
 * number from the request's name and how many of that name came before it,
 * not its position (a page sends its GraphQL operations in any order, and a
 * second run is a new capture). A listing's id can be passed back as
 * pick_request after the page ran again.
 */
function stableRun(capture) {
  const run = toCaptureResult(capture);
  const seen = new Map();
  const taken = new Set();
  for (const exchange of run.exchanges) {
    const name = nameOf(exchange) || `${exchange.request.method} ${exchange.request.url}`;
    const nth = seen.get(name) ?? 0;
    seen.set(name, nth + 1);
    let id = 1 + (fnv(`${name}|${nth}`) % 899_999) + 100_000;
    while (taken.has(id)) id = id === 999_999 ? 100_000 : id + 1;
    taken.add(id);
    exchange.id = id;
  }
  return run;
}

const QUIET = new Set(["document", "stylesheet", "script", "image", "font", "media", "manifest", "ping", "preflight"]);

/**
 * Requests of one run, best first, for a person or agent to choose from:
 * where each went and what it answered, never a value. With example inputs,
 * those that carry them, ranked; without (a checkbox, a list with no filter),
 * the page's own data requests, its writes first when a write is wanted.
 */
export function proposeCandidates({ capture, example, side_effect: sideEffect }) {
  const run = stableRun(capture);
  const args = plainArgs(example ?? {}, "example", { allowEmpty: true });
  const describe = (candidate) => ({
    id: candidate.id,
    request: requestName(candidate.method, candidate.url, candidate.operationName),
    method: candidate.method,
    url: requestName(candidate.method, candidate.url).replace(/^\S+ /, ""),
    resource_type: candidate.resourceType,
    status: candidate.status,
    content_type: candidate.contentType,
    ...(candidate.operationName ? { operation_name: candidate.operationName } : {}),
    carries: candidate.hits,
    score: candidate.score
  });
  if (Object.keys(args).length) {
    return rankCandidates(run.exchanges, args, { pages: capturePages(run) }).slice(0, 8).map(describe);
  }
  const write = sideEffect === "write";
  return rankCandidates(run.exchanges, {}, { pages: capturePages(run) })
    .filter((candidate) => !QUIET.has(candidate.resourceType))
    .map((candidate) => ({ candidate, writes: candidate.method !== "GET" && candidate.method !== "HEAD" }))
    .sort((a, b) => (write ? Number(b.writes) - Number(a.writes) : Number(a.writes) - Number(b.writes)) || b.candidate.score - a.candidate.score)
    .slice(0, 12)
    .map(({ candidate }) => describe(candidate));
}

/**
 * The captured request a pick names: a listed id, or "METHOD https://host/path"
 * with " #Operation" for one GraphQL operation (the best of those, when several).
 */
function pickedExchange(pick, run, args) {
  if (Number.isInteger(pick) || /^\d+$/.test(String(pick).trim())) {
    const id = Number(pick);
    if (!run.exchanges.some((exchange) => exchange.id === id)) throw fail("API_LEARN_FAILED", `no captured request with id ${id}`);
    return id;
  }
  const [method, rawUrl, ...rest] = String(pick).trim().split(/\s+/);
  let url = rawUrl ?? "";
  let operation = rest.join(" ").replace(/^#/, "");
  if (url.includes("#")) [url, operation] = [url.slice(0, url.indexOf("#")), url.slice(url.indexOf("#") + 1) || operation];
  const name = url ? requestName(method, url, operation || undefined) : "";
  if (!name) throw fail("API_LEARN_INPUT", 'pick_request names a request as "METHOD https://host/path" (with " #Operation" for one GraphQL operation), or by its listed id');
  // without an operation name, any operation at that address
  const pool = run.exchanges.filter((exchange) => (operation ? nameOf(exchange) : requestName(exchange.request.method, exchange.request.url)) === name);
  if (!pool.length) throw fail("API_LEARN_FAILED", `no captured request is ${name}`);
  const ranked = rankCandidates(pool, args, { all: true, pages: capturePages(run) });
  return ranked[0]?.id ?? pool[pool.length - 1].id;
}

// fields that name what a request acts on: an id, a sku, a slug, a video
const TARGET_KEY = /(^|[^a-z])(id|ids|sku|slug|key|handle|target|url|uri)$|video|item|product|playlist|listing|post|channel|user|account/i;

/**
 * What a learned write acts on, for the person to see before every run.
 * With inputs, the target is those inputs. Without, it is the learned
 * request's own identifying values (path segments, query and body fields
 * named like ids), never a session value: those are references by now.
 */
// a form's own bookkeeping, never the item it acts on
const FORM_BOOKKEEPING = /^(form_type|utf8|_method|authenticity_token|csrf.*|_token|return_to|section[-_]id|sections(_url)?)$/i;

/** The text fields of a multipart/form-data body (a Shopify product form). */
export function multipartFields(request) {
  const type = Object.entries(request.headers || {}).find(([name]) => name.toLowerCase() === "content-type")?.[1] || "";
  const boundary = /multipart\/form-data;.*boundary="?([^";]+)"?/i.exec(String(type))?.[1];
  if (!boundary || typeof request.body !== "string") return [];
  const fields = [];
  for (const part of request.body.split(`--${boundary}`)) {
    const split = part.indexOf("\r\n\r\n");
    if (split < 0) continue;
    const head = part.slice(0, split);
    const name = /content-disposition:[^\r\n]*;\s*name="([^"]*)"/i.exec(head)?.[1];
    if (!name || /filename=/i.test(head)) continue;
    fields.push({ name, value: part.slice(split + 4).replace(/\r\n$/, "") });
  }
  return fields;
}

/** The site's own name for what a write acted on, from its learned answer: "Akshat (Rice)". */
function targetLabel(exchange) {
  let data;
  try {
    data = JSON.parse(exchange?.response?.body ?? "");
  } catch {
    return undefined;
  }
  const item = Array.isArray(data?.items) && data.items.length === 1 ? data.items[0] : data;
  if (!item || typeof item !== "object") return undefined;
  const text = (value) => (typeof value === "string" && value.trim() && value.length <= 80 ? value.trim() : "");
  const product = text(item.product_title);
  const variant = text(item.variant_title);
  const label = product ? (variant && !/^default title$/i.test(variant) ? `${product} (${variant})` : product) : text(item.title) || text(item.name);
  return label || undefined;
}

function writeTarget(contract, exchange) {
  const request = requestName(contract.request.method, contract.request.url);
  if (contract.params.length) return { kind: "parameter", request, params: contract.params.map((param) => param.name) };
  const label = targetLabel(exchange);
  const slotted = new Set(contract.slots.map((slot) => JSON.stringify(slot.at)));
  const fields = [];
  for (const leaf of walk(contract.request)) {
    if (leaf.container || slotted.has(JSON.stringify(leaf.at)) || leaf.at[0].startsWith("header:")) continue;
    const value = String(leaf.value ?? "");
    if (!value || value.length > 120 || /[{}]/.test(value)) continue;
    const key = String(leaf.at.at(-1)).split(/[/:]/).at(-1);
    const path = leaf.at[0].startsWith("path:");
    if (!path && !TARGET_KEY.test(key)) continue;
    if (path && !/\d|[A-Z].*[a-z]|[a-z].*[A-Z]/.test(value)) continue; // a word in the path is the endpoint, not an item
    // the nearest named step: json:/items/0/id names "id", not "0"
    const tokens = leaf.at.flatMap((step) => (step.startsWith("json:") ? step.slice(5).split("/") : [step.slice(step.indexOf(":") + 1)]));
    const fieldName = tokens.reverse().find((token) => token && !/^\d+$/.test(token)) || "id";
    if (FORM_BOOKKEEPING.test(fieldName)) continue;
    fields.push({ at: leaf.at.join(" "), name: fieldName, value });
    if (fields.length === 8) break;
  }
  // a multipart body is one text to the codec: read its fields here
  for (const field of multipartFields(contract.request)) {
    if (fields.length === 8) break;
    const value = field.value;
    if (!value || value.length > 120 || FORM_BOOKKEEPING.test(field.name) || !TARGET_KEY.test(field.name)) continue;
    fields.push({ at: `body multipart:${field.name}`, name: field.name, value });
  }
  return { kind: "fixed", request, fields, ...(label ? { label } : {}) };
}

/** Upstream's hints name its own command line; here the choice is pick_request. */
function localHints(text) {
  return String(text)
    .replace(/\s*\(capture, then add --from <id> --pick-request <n>\)/g, " (choose it with pick_request from the requests listed)")
    .replace(/,? or (learn )?the page itself with --html or --embedded/g, "")
    .replace(/,? or pass --match/g, "")
    .replace(/pass id or match to choose/g, "pass pick_request to choose")
    .replace(/response is HTML: add --html .*$/, "response is HTML: a whole page, not data; pick the request that returns the data")
    .replace(/--example2 (\w+)=\.\.\., and --from2 when learning from captures/g, "a second example for $1");
}

// A framework's anonymous session (AniList's laravel_session) is set for every
// visitor, signed in or not: it says nothing about a sign-in.
const ANONYMOUS_SESSION = /^(laravel_session|ci_session|phpsessid|jsessionid|asp\.net_sessionid|connect\.sid)$/i;

/**
 * Cookies that can be credentials. A cookie whose whole value is the site's
 * own host or a parent domain of it (a tracker's IR_gbd = "coursera.org",
 * _li_dcdm_c = ".meetup.com") is public: every address on the site contains
 * it, so treating it as a live credential would refuse every request whose
 * referer or origin names the page.
 */
export function credentialCookies(cookies, urls) {
  const hosts = new Set();
  for (const url of urls) {
    try {
      hosts.add(new URL(url).hostname.toLowerCase());
    } catch {
      // not an address
    }
  }
  const isDomainOfSite = (value) => {
    const domain = String(value).trim().toLowerCase().replace(/^\./, "");
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) && !/^[\d.]+$/.test(domain)) return false;
    return [...hosts].some((host) => host === domain || host.endsWith(`.${domain}`));
  };
  return cookies.filter((cookie) => !isDomainOfSite(cookie.value));
}

const GRAPHQL_DOCUMENT = /^\s*(query|mutation|subscription|fragment)\b[^{}]*\{/;

/**
 * A value anyone visiting the page can read, so never a credential: the
 * site's own domain, an address on one of the capture's hosts (whose query
 * holds no token), a path the capture visited, a GraphQL document or one of
 * its operation names. Shopify keeps the product page's address in storage,
 * Coursera its domain, Apollo the query it sends.
 */
function publicValue(text, site) {
  const value = String(text).trim();
  if (!value) return true;
  if (GRAPHQL_DOCUMENT.test(value) || site.operations.has(value)) return true;
  const domain = value.toLowerCase().replace(/^\./, "");
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) && [...site.hosts].some((host) => host === domain || host.endsWith(`.${domain}`))) return true;
  let url;
  try {
    url = new URL(value, "http://relative.invalid");
  } catch {
    return false;
  }
  const relative = url.host === "relative.invalid";
  if (relative ? !value.startsWith("/") || !site.paths.has(url.pathname) : !site.hosts.has(url.hostname.toLowerCase())) return false;
  // an address that carries a token (a callback's ?code=, a signed link) is not public
  const parts = [...url.searchParams.values(), url.hash.slice(1), ...url.pathname.split("/")];
  return !parts.some((part) => part.length >= 16 && (opaqueToken(part) || highEntropy(part)));
}

/** The hosts, paths and GraphQL operation names a run's page and requests show. */
function siteOf(run) {
  const site = { hosts: new Set(), paths: new Set(), operations: new Set() };
  for (const address of [run.finalUrl, ...run.locations, ...run.exchanges.map((exchange) => exchange.request.url)]) {
    try {
      const url = new URL(address);
      site.hosts.add(url.hostname.toLowerCase());
      site.paths.add(url.pathname);
    } catch {
      // not an address
    }
  }
  for (const exchange of run.exchanges) {
    const operation = operationNameOf(exchange.request);
    if (operation) site.operations.add(operation);
  }
  return site;
}

/**
 * Page storage without its public values: an entry that is one is left out,
 * and a JSON entry keeps only its other leaves. Learning then neither turns a
 * page address into a session reference nor refuses an operation for
 * "keeping" one. Tokens, visitor ids and anything random-looking stay.
 */
export function privateStorage(storage, run) {
  const site = siteOf(run);
  const out = {};
  for (const [key, value] of Object.entries(storage || {})) {
    if (publicValue(value, site)) continue;
    if (!/^\s*[[{]/.test(value)) {
      out[key] = value;
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      out[key] = value;
      continue;
    }
    let dropped = false;
    const prune = (node) => {
      if (typeof node === "string") {
        if (publicValue(node, site)) {
          dropped = true;
          return undefined;
        }
        return node;
      }
      if (Array.isArray(node)) return node.map(prune);
      if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([name, child]) => [name, prune(child)]).filter(([, child]) => child !== undefined));
      return node;
    };
    const kept = prune(parsed);
    out[key] = dropped ? JSON.stringify(kept) : value;
  }
  return out;
}

/**
 * What stood between the page and its data in a run: a sign-in page, a rate
 * limit or a bot wall. A learn that meets one says so (auth, rate_limited,
 * blocked) instead of failing to find the request.
 */
function obstacle(run, exchangeId) {
  if (run.finalUrl && loginPath(run.finalUrl)) return { code: "API_LEARN_AUTH", class: "auth", reason: "the page went to a sign-in page: sign in on the site, then teach it again" };
  const looked = run.exchanges.filter((exchange) => exchange.response && (exchangeId === undefined ? !QUIET.has(exchange.resourceType) || exchange.resourceType === "document" : exchange.id === exchangeId));
  for (const exchange of looked) {
    const response = { status: exchange.response.status, headers: exchange.response.headers || {}, body: exchange.response.body ?? "" };
    const wall = botWall(response, exchange.resourceType !== "document");
    if (wall) return { code: "API_LEARN_BLOCKED", class: "blocked", reason: `the site answered with a bot check (${wall}); learning needs the real answer` };
    if (response.status === 429) return { code: "API_LEARN_RATE_LIMITED", class: "rate_limited", reason: `the site rate-limited the page (HTTP 429${response.headers["retry-after"] ? `, retry after ${response.headers["retry-after"]}` : ""}): try again later` };
    if (exchange.resourceType === "document" && /html/i.test(response.headers["content-type"] || "") && signInForm(response.body)) {
      return { code: "API_LEARN_AUTH", class: "auth", reason: "the page showed a sign-in form: sign in on the site, then teach it again" };
    }
  }
  return undefined;
}

function obstacleError(found) {
  return Object.assign(fail(found.code, found.reason), { class: found.class });
}

// what a per-keystroke request is called: it carries the input as well as the real search
const AUTOCOMPLETE = /auto-?complete|suggest|typeahead|type-ahead|complete\/search|\/complete\b|\/predict|prefetch/i;
const isAutocomplete = (candidate) => {
  try {
    const url = new URL(candidate.url);
    return AUTOCOMPLETE.test(`${url.hostname}${url.pathname}`) || AUTOCOMPLETE.test(candidate.operationName || "");
  } catch {
    return false;
  }
};

/** Signed in by a token rather than a cookie: an authorization header, or a credential-named value from page storage. */
function tokenSignIn(contract) {
  return (
    contract.slots.some((slot) => holdsRef(slot) && (slot.at[0] === "header:authorization" || credentialName(leafName(slot.at)))) ||
    (contract.session_sources || []).some((source) => source.kind !== "cookie" && credentialName(String(source.key || source.ref)))
  );
}

/** Upstream's trigger: the page URL with each example value as `{name}`, plus any UI steps. */
function triggerFor(input, run, args) {
  const given = input.trigger;
  if (given && typeof given.url === "string") {
    return {
      url: given.url.includes("{") ? given.url : templatizeUrl(given.url, args),
      ...(Array.isArray(given.steps) && given.steps.length ? { steps: given.steps } : {})
    };
  }
  const page = run.locations[0] || run.finalUrl;
  if (!page) throw fail("API_LEARN_INPUT", "the capture has no page address to replay");
  return { url: templatizeUrl(page, args) };
}

/** Judges one learned run's own response with the learned recipe. */
function exampleCheck(op, exchange, argNames, checkedAt) {
  const response = exchange?.response;
  if (!response) {
    return {
      check: { kind: "learned_examples", passed: false, arg_names: argNames, detail: "the run's request has no response", checked_at: checkedAt }
    };
  }
  if (!structuredResponse(op.response)) {
    return {
      check: {
        kind: "learned_examples",
        passed: false,
        arg_names: argNames,
        detail: "the request answers with a whole page (HTML), not data: pick the request that returns the data",
        checked_at: checkedAt
      }
    };
  }
  const judged = judge(op, { status: response.status, headers: response.headers, body: response.body ?? "", url: exchange.request.url });
  const count = judged.class === "ok" ? itemCount(judged.data) : 0;
  return {
    check: {
      kind: "learned_examples",
      passed: judged.class === "ok" && count > 0,
      class: judged.class,
      arg_names: argNames,
      item_count: count,
      ...(judged.class !== "ok" ? { detail: String(judged.reason || "").slice(0, 300) } : count === 0 ? { detail: "the recipe found no items in the run's response" } : {}),
      checked_at: checkedAt
    },
    fingerprint: judged.class === "ok" ? dataFingerprint(judged.data) : undefined
  };
}

/** The private inputs whose learning value (as typed, URL-encoded or JSON-escaped) still appears in the contract. */
function privateValuesIn(contract, privateParams, examples) {
  const text = JSON.stringify(contract);
  const found = new Set();
  for (const name of privateParams) {
    for (const example of examples) {
      const value = example[name];
      if (value === undefined || value === null) continue;
      const raw = String(value);
      // very short values (a "1", a "no") also occur by chance; longer ones are the person's
      if (raw.length < 4) continue;
      const forms = [raw, encodeURIComponent(raw), encodeURIComponent(raw).replace(/%20/g, "+"), JSON.stringify(raw).slice(1, -1)];
      if (forms.some((form) => text.includes(form))) found.add(name);
    }
  }
  return [...found];
}

/**
 * input: {name, captures: [run1, run2?], examples: [args1, args2?], trigger?,
 * exchange_id?, side_effect?, description?, login_cookies?, public?,
 * private_params?, evidence_ids?, source?}
 *
 * Returns {contract, warnings, candidates, evidence, example_fingerprints}.
 * Cookie and storage values are used while learning and dropped: the
 * contract lists refs by name, and nothing returned holds a value.
 */
export function learnApiOperation(input) {
  if (!input || typeof input !== "object") throw fail("API_LEARN_INPUT", "learning needs an object");
  const name = String(input.name || "");
  if (!NAME.test(name)) throw fail("API_LEARN_INPUT", "name must start with a letter and use letters, digits, - or _ (64 at most)");
  const captures = Array.isArray(input.captures) ? input.captures : [];
  const examples = Array.isArray(input.examples) ? input.examples : [];
  if (!captures.length || captures.length !== examples.length || captures.length > 2) {
    throw fail("API_LEARN_INPUT", "give one run per example: two runs with two different example inputs");
  }
  // no inputs at all (a checkbox, a list with no filter) is allowed once a request is picked
  const noInputs = examples.every((example) => example && typeof example === "object" && !Array.isArray(example) && !Object.keys(example).length);
  const args1 = plainArgs(examples[0], "example 1", { allowEmpty: noInputs });
  const args2 = examples[1] ? plainArgs(examples[1], "example 2", { allowEmpty: noInputs }) : undefined;
  if (args2 && !noInputs) {
    const names1 = Object.keys(args1).sort().join(",");
    if (names1 !== Object.keys(args2).sort().join(",")) throw fail("API_LEARN_INPUT", "both examples must name the same inputs");
    if (Object.keys(args1).every((key) => String(args1[key]).toLowerCase() === String(args2[key]).toLowerCase())) {
      throw fail("API_LEARN_INPUT", "the two examples must differ, or the runs prove nothing about where the input goes");
    }
  }
  try {
    checkExamples(args1, "example 1", args2);
    if (args2) checkExamples(args2, "example 2", args1);
  } catch (error) {
    throw fail("API_LEARN_INPUT", error.message);
  }
  const run1 = stableRun(captures[0]);
  const run2 = captures[1] ? stableRun(captures[1]) : undefined;
  for (const run of [run1, run2].filter(Boolean)) {
    run.cookies = credentialCookies(run.cookies, [run.finalUrl, ...run.locations, ...run.exchanges.map((exchange) => exchange.request.url)]);
    run.storage = privateStorage(run.storage, run);
  }
  const warnings = [];
  if (!run2) warnings.push("learned from one run: nonces and per-load values could not be told apart from constants");
  if (input.side_effect === "write" && input.automated_trigger === true) {
    throw fail("API_LEARN_WRITE_REFUSED", "a write is learned from a person's demonstration only, never by running its trigger");
  }

  const candidatesFor = () => {
    try {
      return proposeCandidates({ capture: captures[0], example: args1, side_effect: input.side_effect });
    } catch {
      return [];
    }
  };
  const withCandidates = (error) => Object.assign(error, { candidates: candidatesFor() });

  // A person or agent names the request (pick_request, or exchange_id: its id
  // in run 1). Without one, several requests can carry the inputs equally
  // well: a per-keystroke autocomplete beside the submitted search, a page's
  // default query before the one with the inputs. The page's last one is the
  // request the person's action produced; upstream would take the first. A
  // whole page that carries them loses to a data request that carries as many.
  const pick = input.pick_request ?? input.exchange_id;
  let pickedId;
  if (pick !== undefined && pick !== null && pick !== "") {
    try {
      pickedId = pickedExchange(pick, run1, args1);
    } catch (error) {
      const found = obstacle(run1);
      throw withCandidates(found ? obstacleError(found) : error);
    }
  } else if (!Object.keys(args1).length) {
    const found = obstacle(run1);
    if (found) throw withCandidates(obstacleError(found));
    // nothing typed (a checkbox, a list with no filter): nothing tells the requests apart
    const error = withCandidates(
      fail("API_LEARN_PICK_REQUEST", "nothing was typed, so no input tells the requests apart: choose the one to learn with pick_request from the requests listed")
    );
    if (!error.candidates.length) {
      error.message = "API_LEARN_PICK_REQUEST: the capture has no data requests to choose from: the page made none while it was watched (wait for it to load, or record the action again)";
    }
    throw error;
  } else if (!input.match) {
    try {
      // The page's own order of preference: a request carrying every input
      // that is data (not a whole page) and not a per-keystroke suggestion;
      // among equals, the page's last one (the person's action, not a default
      // query before it). Upstream would take the first of its ranking.
      const ranked = rankCandidates(run1.exchanges, args1, { pages: capturePages(run1) }).filter((candidate) => candidate.hits.length);
      const isPage = (candidate) => /html/i.test(candidate.contentType || "") || candidate.resourceType === "document";
      const order = new Map(run1.exchanges.map((exchange, index) => [exchange.id, index]));
      const full = ranked.filter((candidate) => candidate.hits.length >= (ranked[0]?.hits.length ?? 0));
      const prefer = (pool, test) => (pool.some(test) ? pool.filter(test) : pool);
      const pool = prefer(prefer(full, (candidate) => !isAutocomplete(candidate)), (candidate) => !isPage(candidate));
      const top = Math.max(...pool.map((candidate) => candidate.score));
      const tied = pool.filter((candidate) => candidate.score === top);
      const chosen = tied.reduce((last, candidate) => ((order.get(candidate.id) ?? 0) > (order.get(last.id) ?? 0) ? candidate : last), tied[0]);
      if (chosen && ranked[0] && chosen.id !== ranked[0].id) {
        pickedId = chosen.id;
        const why = isAutocomplete(ranked[0]) ? "a suggestions request" : isPage(ranked[0]) ? "a whole page" : "one of several that carry the inputs equally";
        warnings.push(`learned ${nameOf(run1.exchanges.find((exchange) => exchange.id === chosen.id))} rather than ${why} (pass pick_request to choose another)`);
      } else if (tied.length > 1) {
        pickedId = chosen.id;
      }
    } catch {
      // upstream's own ranking reports the problem below
    }
  }

  let learned;
  try {
    learned = learnOperation({
      exchanges: run1.exchanges,
      ...(run2 ? { exchanges2: run2.exchanges } : {}),
      examples: args2 ? [args1, args2] : [args1],
      cookies: run1.cookies,
      storage: run1.storage,
      pages: capturePages(run1),
      name,
      trigger: triggerFor(input, run1, args1),
      readOnly: input.side_effect !== "write",
      ...(pickedId !== undefined ? { id: pickedId } : {}),
      ...(Array.isArray(input.login_cookies) ? { loginCookies: input.login_cookies.map(String) } : {}),
      ...(Array.isArray(input.public) ? { public: input.public.map(String) } : {})
    });
  } catch (error) {
    const found = obstacle(run1, pickedId) || (run2 ? obstacle(run2) : undefined);
    if (found) throw withCandidates(obstacleError(found));
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw withCandidates(fail("API_LEARN_FAILED", localHints(message)));
  }
  {
    // the learned request itself answered with a rate limit, a bot check or a sign-in page
    const found = obstacle(run1, learned.exchange?.id);
    if (found) throw withCandidates(obstacleError(found));
    // and the second example's run (RC3: a 429 there was learned past)
    const second = run2 ? obstacle(run2, learned.exchange2?.id) : undefined;
    if (second) throw withCandidates(obstacleError(second));
  }
  warnings.push(...learned.warnings.map(localHints));

  const declared = input.side_effect === "read" || input.side_effect === "write" ? input.side_effect : undefined;
  // what a person typed into anything not proven to be a read is theirs (a
  // message, a name, an address): keep none of it, whatever the caller listed
  const sideEffect = classifySideEffect(learned.exchange?.request || learned.operation.request, { operationName: learned.operation.match?.operationName, declared }).side_effect;
  const givenPrivate = Array.isArray(input.private_params) ? input.private_params.map(String) : [];
  const privateParams = sideEffect === "read" ? givenPrivate : [...new Set([...givenPrivate, ...Object.keys(args1), ...learned.operation.params.map((param) => param.name)])];
  const contract = contractFromOperation(learned.operation, {
    side_effect: declared,
    observed_request: learned.exchange?.request,
    description: typeof input.description === "string" ? input.description.slice(0, 500) : undefined,
    private_params: privateParams,
    source: input.source === "repair" || input.source === "watch_me" || input.source === "network_capture" ? input.source : "two_example_learning",
    evidence_ids: Array.isArray(input.evidence_ids) ? input.evidence_ids.map(String).slice(0, 20) : [],
    storage: run1.storage,
    warnings,
    ...(typeof input.parent_operation_id === "string" ? { parent_operation_id: input.parent_operation_id } : {}),
    example_inputs: { learning: args2 ? [args1, args2] : [args1] }
  });

  // signed in: a credential cookie that is not every visitor's anonymous session
  // or by a token: an authorization header, a credential the page keeps in storage
  contract.learned_logged_in =
    loggedIn(
      run1.cookies.filter((cookie) => !ANONYMOUS_SESSION.test(cookie.name)),
      Array.isArray(input.login_cookies) ? input.login_cookies.map(String) : undefined
    ) || tokenSignIn(contract);

  // Fail closed: a live cookie or storage value anywhere in the contract means
  // the learner kept a credential literal.
  const live = {
    cookies: [...run1.cookies, ...(run2?.cookies || [])],
    values: { ...learned.sessionValues, ...run1.storage, ...(run2?.storage || {}) }
  };
  const scan = scanSecrets(contract, live, new Set());
  if (scan.secrets.length) {
    throw withCandidates(fail("API_LEARN_SECRET", `the learned operation would keep a session value (${scan.secrets.slice(0, 3).join("; ")}); not saved. Choose another request with pick_request from the requests listed`));
  }
  contract.provenance.warnings = [...contract.provenance.warnings, ...scan.warnings].slice(0, 20);
  // Fail closed again: no private input's learning value may survive anywhere in the contract.
  const kept = privateValuesIn(contract, privateParams, args2 ? [args1, args2] : [args1]);
  if (kept.length) {
    throw fail("API_LEARN_PRIVATE_VALUE", `the learned operation would keep what was typed into ${kept.join(", ")}; not saved`);
  }

  if (contract.side_effect !== "read") contract.target = writeTarget(contract, learned.exchange);

  const op = toUpstreamOperation(contract);
  const checkedAt = new Date().toISOString();
  const argNames = Object.keys(args1);
  const first = exampleCheck(op, learned.exchange, argNames, checkedAt);
  const second = learned.exchange2 ? exampleCheck(op, learned.exchange2, argNames, checkedAt) : undefined;
  if (!first.check.passed) {
    // nothing usable was learned: say what was in the way, if something was
    const found = obstacle(run1);
    if (found) throw withCandidates(obstacleError(found));
  }
  contract.verification = {
    status: first.check.passed && (second?.check.passed ?? true) ? "unverified" : "failed",
    checks: [first.check, ...(second ? [second.check] : [])]
  };

  return {
    contract,
    warnings: contract.provenance.warnings,
    evidence: {
      run1: where(learned.exchange),
      ...(learned.exchange2 ? { run2: where(learned.exchange2) } : {})
    },
    example_fingerprints: [first.fingerprint, second?.fingerprint].filter(Boolean)
  };
}
