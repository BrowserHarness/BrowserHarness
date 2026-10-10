// Hybrid execution: a learned operation is tried by tier, cheapest first.
// Tier 1 is plain HTTP from the Bridge, tier 2 the same request sent from a
// page of the site (its own cookies), tier 3 the page itself doing what it
// does while BrowserHarness records the answer. The tier that last answered
// for an operation goes first next time. A write gets one attempt that reaches
// the site: it moves to another tier only when nothing was sent.
import type { ApiCallResult, ApiOperationContract, ApiResultClass, ApiTier } from "./api-recipe";

export interface ApiAttempt {
  tier: ApiTier;
  class: ApiResultClass;
  sent: boolean;
  reason?: string;
  ms?: number;
}

export type ApiDispatchResult = ApiCallResult & { attempts: ApiAttempt[] };

export interface ApiDispatchDeps {
  run(tier: ApiTier, contract: ApiOperationContract, args: Record<string, unknown>, approved: boolean): Promise<ApiCallResult & { sent?: boolean }>;
  /** the tier that last answered for this operation, if remembered */
  remembered(operationId: string): Promise<ApiTier | undefined>;
  remember(operationId: string, tier: ApiTier): Promise<void>;
}

/** Read failures another tier can get past: the page has the session, or passes the bot check. */
const READ_FALLTHROUGH = new Set<ApiResultClass>(["unavailable", "auth", "blocked", "network"]);

/** The tiers to try, in order: the remembered one first, never below the operation's minimum. */
export function tierOrder(contract: ApiOperationContract, remembered?: ApiTier, maxTier: ApiTier = 3): ApiTier[] {
  const preference = (contract.transport?.preference?.length ? contract.transport.preference : [1, 2, 3]) as ApiTier[];
  const allowed = [...new Set(preference)].filter((tier) => tier >= (contract.min_tier || 1) && tier <= maxTier);
  const first = remembered ?? contract.transport?.learned_tier;
  return first && allowed.includes(first) ? [first, ...allowed.filter((tier) => tier !== first)] : allowed;
}

/** Whether a failed attempt may go on to the next tier. */
export function mayTryNext(contract: ApiOperationContract, attempt: ApiCallResult & { sent?: boolean }): boolean {
  if (attempt.class === "approval_required" || attempt.class === "input" || attempt.class === "rate_limited") return false;
  if (contract.side_effect !== "read") {
    // nothing left the browser or the Bridge: another tier may send it, once
    return attempt.sent === false && (attempt.class === "unavailable" || attempt.class === "auth");
  }
  return READ_FALLTHROUGH.has(attempt.class);
}

export async function dispatchApiOperation(
  deps: ApiDispatchDeps,
  contract: ApiOperationContract,
  args: Record<string, unknown>,
  { approved = false, maxTier = 3 }: { approved?: boolean; maxTier?: ApiTier } = {}
): Promise<ApiDispatchResult> {
  const order = tierOrder(contract, await deps.remembered(contract.operation_id).catch(() => undefined), maxTier);
  const attempts: ApiAttempt[] = [];
  let last: (ApiCallResult & { sent?: boolean }) | undefined;
  for (const tier of order) {
    let answer: ApiCallResult & { sent?: boolean };
    try {
      answer = await deps.run(tier, contract, args, approved);
    } catch (error) {
      // a transport that threw may have sent a write: never try it again
      answer = {
        ok: false,
        class: contract.side_effect === "read" ? "network" : "ambiguous_write",
        tier,
        sent: contract.side_effect !== "read",
        reason: error instanceof Error ? error.message : String(error),
        ...(contract.side_effect === "read" ? {} : { next: "the write may have run: check the site; do not resend" }),
        operation_id: contract.operation_id,
        fetched_at: new Date().toISOString(),
        fresh: true
      };
    }
    last = answer;
    attempts.push({
      tier,
      class: answer.class,
      sent: answer.sent !== false,
      ...(answer.reason ? { reason: answer.reason.slice(0, 200) } : {}),
      ...(answer.ms !== undefined ? { ms: answer.ms } : {})
    });
    if (answer.ok) {
      await deps.remember(contract.operation_id, tier).catch(() => undefined);
      return { ...answer, attempts };
    }
    if (!mayTryNext(contract, answer)) break;
  }
  if (!last) {
    return {
      ok: false,
      class: "unavailable",
      tier: (contract.min_tier || 1) as ApiTier,
      reason: "no tier can run this operation here",
      operation_id: contract.operation_id,
      fetched_at: new Date().toISOString(),
      fresh: true,
      attempts
    };
  }
  return { ...last, attempts };
}

const KEY = "browserharness.apiTransport.v1";
const MAX_REMEMBERED = 500;

/** The tier that last answered, per operation; kept in extension storage (no values, just a number). */
export async function rememberedTier(operationId: string): Promise<ApiTier | undefined> {
  const stored = (await chrome.storage.local.get(KEY))[KEY] as Record<string, { tier: ApiTier; at: string }> | undefined;
  return stored?.[operationId]?.tier;
}

export async function rememberTier(operationId: string, tier: ApiTier): Promise<void> {
  const stored = ((await chrome.storage.local.get(KEY))[KEY] || {}) as Record<string, { tier: ApiTier; at: string }>;
  stored[operationId] = { tier, at: new Date().toISOString() };
  const entries = Object.entries(stored).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, MAX_REMEMBERED);
  await chrome.storage.local.set({ [KEY]: Object.fromEntries(entries) });
}
