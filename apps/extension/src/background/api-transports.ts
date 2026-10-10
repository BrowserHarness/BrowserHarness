// The three ways a learned operation reaches a site. The Bridge builds and
// judges every request; the extension only does what needs the browser: send
// it from a page of the site (tier 2), or load the operation's page and record
// what it sends (tier 3). Every tab used here is a background tab this call
// opens and closes. Cookies and storage are read for the one call and dropped.
import { requestBridgeApi, type BridgeRpcResult } from "./bridge-client";
import { cdpCommand } from "./cdp-manager";
import { collectApiCapture, waitForOperationRequest } from "./api-capture";
import { startNetworkCapture, stopNetworkCapture } from "./network-capture";
import { evaluatePageExpression } from "./page-evaluate";
import { waitForTabUsable } from "./navigation";
import type { ApiCallResult, ApiOperationContract, ApiTier } from "../runtime/api-recipe";

const MAX_BODY = 2_000_000;

function failed(contract: ApiOperationContract, tier: ApiTier, reply: BridgeRpcResult): ApiCallResult {
  const code = reply.error?.code || "API_ENGINE_FAILED";
  return {
    ok: false,
    class: code === "API_ENGINE_UNAVAILABLE" || code === "BRIDGE_DISCONNECTED" ? "unavailable" : "network",
    tier,
    sent: false,
    reason: reply.error?.message || "The helper app could not do that",
    operation_id: contract.operation_id,
    fetched_at: new Date().toISOString(),
    fresh: true
  };
}

async function withBackgroundTab<T>(url: string, fn: (tabId: number) => Promise<T>, before?: (tabId: number) => Promise<void>): Promise<T> {
  const tab = await chrome.tabs.create({ url: before ? "about:blank" : url, active: false });
  if (!tab?.id) throw new Error("Chrome did not open a tab");
  const tabId = tab.id;
  try {
    if (before) {
      await before(tabId);
      await chrome.tabs.update(tabId, { url });
    }
    await waitForTabUsable(tabId);
    return await fn(tabId);
  } finally {
    await chrome.tabs.remove(tabId).catch(() => undefined);
  }
}

const STORAGE = `(() => { const out = {}; for (const store of [localStorage, sessionStorage]) { try { for (let i = 0; i < store.length; i++) { const key = store.key(i); if (key !== null && !(key in out)) out[key] = String(store.getItem(key) || "").slice(0, 20000); } } catch {} } return out; })()`;

/** The page's own fetch, credentials included, redirects not followed (the Bridge's redirect policy). */
export function pageFetchExpression(request: { url: string; method: string; headers: Record<string, string>; body?: string }): string {
  return `(async () => {
  try {
    const response = await fetch(${JSON.stringify(request.url)}, {
      method: ${JSON.stringify(request.method)},
      headers: ${JSON.stringify(request.headers)},
      ${request.body !== undefined ? `body: ${JSON.stringify(request.body)},` : ""}
      credentials: "include",
      redirect: "manual"
    });
    if (response.type === "opaqueredirect") return { redirected_opaque: true, status: 0, headers: {}, body: "" };
    const text = await response.text();
    return { status: response.status, headers: Object.fromEntries(response.headers), body: text.slice(0, ${MAX_BODY}), url: response.url };
  } catch (error) {
    return { error: String(error && error.message || error) };
  }
})()`;
}

/** Tier 1: plain HTTP from the Bridge, with no browser session (a signed-in API answers auth and moves to tier 2). */
export async function runTier1(contract: ApiOperationContract, args: Record<string, unknown>, approved: boolean): Promise<ApiCallResult> {
  const reply = await requestBridgeApi("call", { contract, args }, { approved });
  return reply.ok ? (reply.data as ApiCallResult) : failed(contract, 1, reply);
}

/** Where tier 2 sends from: a light same-origin document first, the site's home page if that one leaves the origin. */
export const TIER2_PAGES = ["/robots.txt", "/"];

function onOrigin(url: string | undefined, origin: string): boolean {
  try {
    return new URL(url || "").origin === origin;
  } catch {
    return false;
  }
}

/** Tier 2: the same request sent from a page of the site, with that page's own cookies. */
export async function runTier2(contract: ApiOperationContract, args: Record<string, unknown>, approved: boolean): Promise<ApiCallResult> {
  const pageOrigin = new URL(contract.trigger.url.replace(/\{[^{}]*\}/g, "x")).origin;
  const started = performance.now();
  for (const path of TIER2_PAGES) {
    const answer = await withBackgroundTab(`${pageOrigin}${path}`, async (tabId) => {
      // a redirect to another site, a challenge on another host or an error page: never send from there
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!onOrigin(tab?.url, pageOrigin)) return null;
      const storage = ((await evaluatePageExpression(tabId, STORAGE, 4_000_000).catch(() => undefined))?.value || {}) as Record<string, string>;
      const cookieReply = await cdpCommand<{ cookies?: Array<Record<string, unknown>> }>(tabId, "Network.getCookies", { urls: [contract.origin, pageOrigin] }).catch(() => ({ cookies: [] }));
      const built = await requestBridgeApi("page_request", { contract, args, session: { cookies: cookieReply.cookies || [], storage } }, { approved });
      if (!built.ok) return failed(contract, 2, built);
      const plan = built.data as { refused?: ApiCallResult; request?: { url: string; method: string; headers: Record<string, string>; body?: string } };
      if (plan.refused) return plan.refused;
      const observed = await evaluatePageExpression(tabId, pageFetchExpression(plan.request!), MAX_BODY + 50_000)
        .then((value) => value.value as Record<string, unknown>)
        .catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
      const judged = await requestBridgeApi("page_answer", { contract, observed: { ...observed, ms: Math.round(performance.now() - started) } });
      if (!judged.ok) {
        // the request was sent: a write must not move on to another tier
        return { ...failed(contract, 2, judged), sent: true, ...(contract.side_effect === "read" ? {} : { class: "ambiguous_write" as const }) };
      }
      return judged.data as ApiCallResult;
    });
    if (answer) return answer;
  }
  return {
    ok: false,
    class: "unavailable",
    tier: 2,
    sent: false,
    reason: `no page of ${pageOrigin} stayed on that site to send the request from`,
    operation_id: contract.operation_id,
    fetched_at: new Date().toISOString(),
    fresh: true
  };
}

/** Tier 3: load the operation's page with the inputs and read the answer to the request it makes. Reads only. */
export async function runTier3(contract: ApiOperationContract, args: Record<string, unknown>): Promise<ApiCallResult> {
  const planned = await requestBridgeApi("page_trigger", { contract, args });
  if (!planned.ok) return failed(contract, 3, planned);
  const plan = planned.data as { refused?: ApiCallResult; url?: string };
  if (plan.refused) return plan.refused;
  const started = performance.now();
  const capture = await withBackgroundTab(
    plan.url!,
    async (tabId) => {
      try {
        await waitForOperationRequest(tabId, contract.match);
        const tab = await chrome.tabs.get(tabId);
        return await collectApiCapture(tabId, tab.url || plan.url!, [plan.url!]);
      } finally {
        await stopNetworkCapture(tabId).catch(() => undefined);
      }
    },
    (tabId) => startNetworkCapture(tabId, 800)
  );
  // only the exchanges go to the Bridge: it matches the request, it needs no cookies
  const judged = await requestBridgeApi("page_run", { contract, capture: { ...capture, cookies: [], storage: {} } });
  if (!judged.ok) return { ...failed(contract, 3, judged), sent: true };
  const result = judged.data as ApiCallResult;
  return { ...result, ms: Math.round(performance.now() - started) };
}

export function runTier(tier: ApiTier, contract: ApiOperationContract, args: Record<string, unknown>, approved: boolean): Promise<ApiCallResult> {
  if (tier === 1) return runTier1(contract, args, approved);
  if (tier === 2) return runTier2(contract, args, approved);
  return runTier3(contract, args);
}
