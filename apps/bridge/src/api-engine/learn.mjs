// Deterministic two-example learning: two runs of the same page with two
// different example inputs, then upstream's learner (vendored) finds the
// request carrying the inputs, its param slots, session refs, nonces and
// response recipe. No LLM. The result is an API Recipe v2 contract that is
// unverified until an unseen third input succeeds (verify.mjs).
import { judge } from "../../vendor/api-anything/dist/classify.js";
import { templatizeUrl } from "../../vendor/api-anything/dist/heal.js";
import { capturePages, checkExamples, learnOperation, rankCandidates } from "../../vendor/api-anything/dist/learn.js";
import { scanSecrets } from "../../vendor/api-anything/dist/secrets.js";
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

/** "POST https://host/path": how a person or agent names a captured request, the same on every run. */
function requestName(method, url) {
  try {
    const parsed = new URL(url);
    return `${String(method).toUpperCase()} ${parsed.origin}${parsed.pathname}`;
  } catch {
    return "";
  }
}

const QUIET = new Set(["document", "stylesheet", "script", "image", "font", "media", "manifest", "ping", "preflight"]);

/**
 * Requests of one run, best first, for a person or agent to choose from:
 * where each went and what it answered, never a value. With example inputs,
 * those that carry them, ranked; without (a checkbox, a list with no filter),
 * the page's own data requests, its writes first when a write is wanted.
 */
export function proposeCandidates({ capture, example, side_effect: sideEffect }) {
  const run = toCaptureResult(capture);
  const args = plainArgs(example ?? {}, "example", { allowEmpty: true });
  const describe = (candidate) => ({
    id: candidate.id,
    request: requestName(candidate.method, candidate.url),
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

/** The captured request a pick names: its id in run 1, or "METHOD https://host/path" (the best of those, when several). */
function pickedExchange(pick, run, args) {
  if (Number.isInteger(pick)) {
    if (!run.exchanges.some((exchange) => exchange.id === pick)) throw fail("API_LEARN_FAILED", `no captured request with id ${pick}`);
    return pick;
  }
  const wanted = String(pick).trim().replace(/\s+/, " ");
  const [method, url] = wanted.split(" ");
  const name = url ? requestName(method, url) : "";
  if (!name) throw fail("API_LEARN_INPUT", 'pick_request names a request as "METHOD https://host/path", or by its id in the capture');
  const pool = run.exchanges.filter((exchange) => requestName(exchange.request.method, exchange.request.url) === name);
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
function writeTarget(contract) {
  const request = requestName(contract.request.method, contract.request.url);
  if (contract.params.length) return { kind: "parameter", request, params: contract.params.map((param) => param.name) };
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
    fields.push({ at: leaf.at.join(" "), value });
    if (fields.length === 8) break;
  }
  return { kind: "fixed", request, fields };
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
  const run1 = toCaptureResult(captures[0]);
  const run2 = captures[1] ? toCaptureResult(captures[1]) : undefined;
  for (const run of [run1, run2].filter(Boolean)) {
    run.cookies = credentialCookies(run.cookies, [run.finalUrl, ...run.locations, ...run.exchanges.map((exchange) => exchange.request.url)]);
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
      throw withCandidates(error);
    }
  } else if (!Object.keys(args1).length) {
    // nothing typed (a checkbox, a list with no filter): nothing tells the requests apart
    throw withCandidates(
      fail("API_LEARN_PICK_REQUEST", "nothing was typed, so no input tells the requests apart: choose the one to learn with pick_request from the requests listed")
    );
  } else if (!input.match) {
    try {
      const ranked = rankCandidates(run1.exchanges, args1, { pages: capturePages(run1) }).filter((candidate) => candidate.hits.length);
      const isPage = (candidate) => /html/i.test(candidate.contentType || "") || candidate.resourceType === "document";
      const data = ranked.find((candidate) => !isPage(candidate) && candidate.hits.length >= (ranked[0]?.hits.length ?? 0));
      const tied = ranked.filter((candidate) => candidate.score === ranked[0]?.score);
      if (ranked[0] && isPage(ranked[0]) && data) {
        pickedId = data.id;
        warnings.push(`request #${ranked[0].id} is a whole page; learned #${data.id}, which returns data and carries the inputs as well (pass pick_request to choose another)`);
      } else if (tied.length > 1) {
        pickedId = Math.max(...tied.map((candidate) => candidate.id));
        warnings.push(`requests ${tied.map((candidate) => `#${candidate.id}`).join(", ")} carry the inputs equally; learned the page's last one, #${pickedId} (pass pick_request to choose another)`);
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
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw withCandidates(fail("API_LEARN_FAILED", localHints(message)));
  }
  warnings.push(...learned.warnings.map(localHints));

  const declared = input.side_effect === "read" || input.side_effect === "write" ? input.side_effect : undefined;
  // what a person typed into anything not proven to be a read is theirs (a
  // message, a name, an address): keep none of it, whatever the caller listed
  const sideEffect = classifySideEffect(learned.operation.request, { operationName: learned.operation.match?.operationName, declared }).side_effect;
  const givenPrivate = Array.isArray(input.private_params) ? input.private_params.map(String) : [];
  const privateParams = sideEffect === "read" ? givenPrivate : [...new Set([...givenPrivate, ...Object.keys(args1), ...learned.operation.params.map((param) => param.name)])];
  const contract = contractFromOperation(learned.operation, {
    side_effect: declared,
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
  contract.learned_logged_in = loggedIn(
    run1.cookies.filter((cookie) => !ANONYMOUS_SESSION.test(cookie.name)),
    Array.isArray(input.login_cookies) ? input.login_cookies.map(String) : undefined
  );

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

  if (contract.side_effect !== "read") contract.target = writeTarget(contract);

  const op = toUpstreamOperation(contract);
  const checkedAt = new Date().toISOString();
  const argNames = Object.keys(args1);
  const first = exampleCheck(op, learned.exchange, argNames, checkedAt);
  const second = learned.exchange2 ? exampleCheck(op, learned.exchange2, argNames, checkedAt) : undefined;
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
