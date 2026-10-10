// The Bridge side of the API engine, reached by the paired extension through
// `api_request` WebSocket messages (docs/protocols/API-RECIPE-V2.md
// "Bridge messages"). It learns, verifies and sends tier-1 calls; tiers 2 and
// 3 run in the extension. Nothing is stored here: contracts live in the
// extension's Site Skill library, and session values arrive per request.
import { API_CONTRACT_VERSION, ENGINE_ID, parseContract } from "./recipe.mjs";
import { learnApiOperation, proposeCandidates } from "./learn.mjs";
import { callTier1 } from "./tier1.mjs";
import { verifyUnseenInput } from "./verify.mjs";
import { buildForPage, judgePageAnswer, judgePageRun, triggerFor } from "./transport.mjs";
import { API_ANYTHING_COMMIT } from "./upstream-adapter.mjs";

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error(`API_REQUEST_INVALID: ${label} must be an object`), { code: "API_REQUEST_INVALID" });
  return value;
}

/** Cookies and storage from the first run, when the request carries none of its own. */
function sessionOf(payload) {
  if (payload.session && typeof payload.session === "object") return payload.session;
  const run = Array.isArray(payload.captures) ? payload.captures[0] : undefined;
  return { cookies: Array.isArray(run?.cookies) ? run.cookies : [], storage: run?.storage && typeof run.storage === "object" ? run.storage : {} };
}

export function createApiEngine({ fetchImpl, minIntervalMs } = {}) {
  const stats = { learned: 0, learn_failures: 0, verified: 0, verify_failures: 0, calls: 0, call_failures: 0 };

  async function handle(action, rawPayload, { approved = false } = {}) {
    const payload = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
    switch (action) {
      case "status":
        return {
          engine: ENGINE_ID,
          contract_version: API_CONTRACT_VERSION,
          upstream: { name: "api-anything", commit: API_ANYTHING_COMMIT },
          bridge_tiers: [1],
          page_tiers: [2, 3],
          stats: { ...stats }
        };
      case "propose":
        return { candidates: proposeCandidates({ capture: object(payload.capture, "capture"), example: payload.example }) };
      case "learn": {
        let learned;
        try {
          learned = learnApiOperation(payload);
          stats.learned += 1;
        } catch (error) {
          stats.learn_failures += 1;
          throw error;
        }
        if (!payload.verify_args) return learned;
        const verification = await verifyUnseenInput(learned.contract, object(payload.verify_args, "verify_args"), {
          examples: payload.examples,
          example_fingerprints: learned.example_fingerprints,
          provided: sessionOf(payload),
          fetchImpl,
          minIntervalMs
        });
        stats[verification.check.passed ? "verified" : "verify_failures"] += 1;
        return { ...learned, contract: verification.contract, verification: verification.check, verification_response: verification.response };
      }
      case "verify": {
        const verification = await verifyUnseenInput(object(payload.contract, "contract"), object(payload.args, "args"), {
          examples: Array.isArray(payload.examples) ? payload.examples : [],
          example_fingerprints: Array.isArray(payload.example_fingerprints) ? payload.example_fingerprints : [],
          provided: sessionOf(payload),
          // a live answer the extension got for these args through another tier
          ...(payload.response && typeof payload.response === "object" ? { response: payload.response } : {}),
          fetchImpl,
          minIntervalMs
        });
        stats[verification.check.passed ? "verified" : "verify_failures"] += 1;
        return verification;
      }
      case "call": {
        const contract = parseContract(object(payload.contract, "contract"));
        const response = await callTier1(contract, payload.args && typeof payload.args === "object" ? payload.args : {}, {
          provided: sessionOf(payload),
          approved: approved === true,
          fetchImpl,
          minIntervalMs
        });
        stats.calls += 1;
        if (!response.ok) stats.call_failures += 1;
        return response;
      }
      // tier 2: the request a page of the site sends, then its answer
      case "page_request":
        return buildForPage(parseContract(object(payload.contract, "contract")), payload.args && typeof payload.args === "object" ? payload.args : {}, {
          provided: sessionOf(payload),
          approved: approved === true
        });
      case "page_answer":
        return judgePageAnswer(parseContract(object(payload.contract, "contract")), object(payload.observed, "observed"));
      // tier 3: the page to load, then what it sent
      case "page_trigger":
        return triggerFor(parseContract(object(payload.contract, "contract")), payload.args && typeof payload.args === "object" ? payload.args : {});
      case "page_run":
        return judgePageRun(parseContract(object(payload.contract, "contract")), object(payload.capture, "capture"));
      default:
        throw Object.assign(new Error(`API_REQUEST_INVALID: unsupported action ${String(action || "")}`), { code: "API_REQUEST_INVALID" });
    }
  }

  return { handle, stats: () => ({ ...stats }) };
}

/** Error codes the extension can act on; anything else is API_ENGINE_FAILED. */
export function apiErrorCode(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error?.code === "string" ? error.code : /^([A-Z][A-Z0-9_]+):/.exec(message)?.[1];
  return code && /^API_/.test(code) ? code : "API_ENGINE_FAILED";
}
