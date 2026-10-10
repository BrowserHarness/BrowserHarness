// Deterministic two-example learning: two runs of the same page with two
// different example inputs, then upstream's learner (vendored) finds the
// request carrying the inputs, its param slots, session refs, nonces and
// response recipe. No LLM. The result is an API Recipe v2 contract that is
// unverified until an unseen third input succeeds (verify.mjs).
import { judge } from "../../vendor/api-anything/dist/classify.js";
import { templatizeUrl } from "../../vendor/api-anything/dist/heal.js";
import { capturePages, checkExamples, learnOperation, rankCandidates } from "../../vendor/api-anything/dist/learn.js";
import { scanSecrets } from "../../vendor/api-anything/dist/secrets.js";
import { toCaptureResult } from "./capture.mjs";
import { dataFingerprint, itemCount } from "./outcome.mjs";
import { contractFromOperation, toUpstreamOperation } from "./recipe.mjs";

const NAME = /^[A-Za-z][\w-]{0,63}$/;

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function plainArgs(args, label) {
  if (!args || typeof args !== "object" || Array.isArray(args) || !Object.keys(args).length) {
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

/** Ranked requests of one run that carry the example inputs, for a person or agent to choose from. */
export function proposeCandidates({ capture, example }) {
  const run = toCaptureResult(capture);
  const args = plainArgs(example, "example");
  return rankCandidates(run.exchanges, args, { pages: capturePages(run) })
    .slice(0, 8)
    .map((candidate) => ({
      id: candidate.id,
      method: candidate.method,
      url: (() => {
        try {
          const url = new URL(candidate.url);
          return `${url.origin}${url.pathname}`;
        } catch {
          return "";
        }
      })(),
      resource_type: candidate.resourceType,
      status: candidate.status,
      content_type: candidate.contentType,
      ...(candidate.operationName ? { operation_name: candidate.operationName } : {}),
      carries: candidate.hits,
      score: candidate.score
    }));
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
  const args1 = plainArgs(examples[0], "example 1");
  const args2 = examples[1] ? plainArgs(examples[1], "example 2") : undefined;
  if (args2) {
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
  const warnings = [];
  if (!run2) warnings.push("learned from one run: nonces and per-load values could not be told apart from constants");
  if (input.side_effect === "write" && input.automated_trigger === true) {
    throw fail("API_LEARN_WRITE_REFUSED", "a write is learned from a person's demonstration only, never by running its trigger");
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
      ...(Number.isInteger(input.exchange_id) ? { id: input.exchange_id } : {}),
      ...(Array.isArray(input.login_cookies) ? { loginCookies: input.login_cookies.map(String) } : {}),
      ...(Array.isArray(input.public) ? { public: input.public.map(String) } : {})
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    const candidates = (() => {
      try {
        return proposeCandidates({ capture: captures[0], example: args1 });
      } catch {
        return [];
      }
    })();
    const wrapped = fail("API_LEARN_FAILED", message);
    wrapped.candidates = candidates;
    throw wrapped;
  }
  warnings.push(...learned.warnings);

  const contract = contractFromOperation(learned.operation, {
    side_effect: input.side_effect === "read" || input.side_effect === "write" ? input.side_effect : undefined,
    description: typeof input.description === "string" ? input.description.slice(0, 500) : undefined,
    private_params: Array.isArray(input.private_params) ? input.private_params.map(String) : [],
    source: input.source || "two_example_learning",
    evidence_ids: Array.isArray(input.evidence_ids) ? input.evidence_ids.map(String).slice(0, 20) : [],
    storage: run1.storage,
    warnings
  });

  // Fail closed: a live cookie or storage value anywhere in the contract means
  // the learner kept a credential literal.
  const live = {
    cookies: [...run1.cookies, ...(run2?.cookies || [])],
    values: { ...learned.sessionValues, ...run1.storage, ...(run2?.storage || {}) }
  };
  const scan = scanSecrets(contract, live, new Set());
  if (scan.secrets.length) {
    throw fail("API_LEARN_SECRET", `the learned operation would keep a session value (${scan.secrets.slice(0, 3).join("; ")}); not saved`);
  }
  contract.provenance.warnings = [...contract.provenance.warnings, ...scan.warnings].slice(0, 20);

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
