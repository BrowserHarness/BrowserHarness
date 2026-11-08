// A run of a page recorded for API learning: its document and data requests
// with their response bodies, plus the cookies and page storage that tell
// credentials from inputs. The capture lives in memory for one learning call;
// the Bridge drops cookie and storage values after learning and nothing here
// writes them anywhere.
import { cdpCommand } from "./cdp-manager";
import {
  listNetworkRecords,
  networkRecordDetail,
  type NetworkRecord
} from "./network-capture";
import { evaluatePageExpression } from "./page-evaluate";

export interface ApiCaptureExchange {
  id: number;
  resource_type: string;
  request: { method: string; url: string; headers: Record<string, string>; body?: string };
  response?: { status: number; headers: Record<string, string>; content_type: string; body?: string };
  aborted?: boolean;
}

export interface ApiCapture {
  capture_version: 1;
  final_url: string;
  locations: string[];
  exchanges: ApiCaptureExchange[];
  cookies: Array<{ name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite?: string }>;
  storage: Record<string, string>;
}

const DATA_TYPES = new Set(["document", "xhr", "fetch", "other"]);
/** The most exchanges one capture sends; the Bridge keeps as many (its MAX_EXCHANGES). */
export const MAX_CAPTURE_EXCHANGES = 400;
const MAX_BODY = 2_000_000;
const MAX_BODIES = 120;
const TEXT_TYPE = /json|text|javascript|xml|html|graphql|x-www-form-urlencoded/i;

function decodeBase64Text(value: string): string | undefined {
  try {
    const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function exchangeFrom(record: NetworkRecord, index: number, body?: string): ApiCaptureExchange {
  return {
    id: index + 1,
    resource_type: record.resource_type || "other",
    request: {
      method: record.method,
      url: record.url,
      headers: record.request_headers || {},
      ...(typeof record.post_data === "string" ? { body: record.post_data } : {})
    },
    ...(typeof record.status === "number"
      ? {
          response: {
            status: record.status,
            headers: record.response_headers || {},
            content_type: record.mime_type || "",
            ...(body !== undefined ? { body: body.slice(0, MAX_BODY) } : {})
          }
        }
      : {}),
    ...(record.error_text && /abort|cancel/i.test(record.error_text) ? { aborted: true } : {})
  };
}

const STORAGE_EXPRESSION = `(() => {
  const out = {};
  const read = (store) => {
    try {
      for (let i = 0; i < store.length && Object.keys(out).length < 400; i++) {
        const key = store.key(i);
        if (key !== null && !(key in out)) out[key] = String(store.getItem(key) || "").slice(0, 20000);
      }
    } catch {}
  };
  read(window.localStorage);
  read(window.sessionStorage);
  return out;
})()`;

/** Waits until the page has made no new request for `quietMs` (or `timeoutMs` passes). */
export async function waitForNetworkQuiet(tabId: number, quietMs = 1200, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  let count = -1;
  let since = Date.now();
  while (Date.now() - started < timeoutMs) {
    const records = listNetworkRecords(tabId, 500);
    const pending = records.some((record) => !record.finished_at && !record.error_text);
    if (records.length !== count || pending) {
      count = records.length;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * The registrable part of a host, approximately: the last two labels, or three
 * under a two-part country suffix (shop.co.uk). An IP address is its own site.
 */
function siteOf(hostname: string): string {
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) return hostname;
  const labels = hostname.split(".");
  const twoPartSuffix = labels.length >= 3 && labels.at(-1)!.length === 2 && labels.at(-2)!.length <= 3;
  return labels.slice(twoPartSuffix ? -3 : -2).join(".");
}

/**
 * The origins whose cookies a learning run reads: the page's own, and any
 * other origin the page called on the same site (api.shop.example for
 * www.shop.example). Analytics, ads and other sites' cookies stay out.
 */
export function cookieOrigins(pageUrl: string, records: Array<{ url: string }>): string[] {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return [];
  }
  const site = siteOf(page.hostname);
  const origins = [page.origin];
  for (const record of records) {
    let url: URL;
    try {
      url = new URL(record.url);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol) || origins.includes(url.origin)) continue;
    const sameSite = /^[\d.]+$/.test(page.hostname) ? url.hostname === page.hostname && url.origin === page.origin : siteOf(url.hostname) === site;
    if (sameSite) origins.push(url.origin);
  }
  return origins.slice(0, 20);
}

/**
 * The records a capture holds: only those made since `since` (a Watch Me
 * recording's start; RC4: a long-used tab's earlier traffic crowded out the
 * demonstrated request), and at most MAX_CAPTURE_EXCHANGES, the newest.
 */
export function captureRecords(records: NetworkRecord[], since?: number): NetworkRecord[] {
  const recent = typeof since === "number" ? records.filter((record) => record.started_at >= since) : records;
  return recent.slice(-MAX_CAPTURE_EXCHANGES);
}

/** Reads the run's capture from the tab's active network capture. */
export async function collectApiCapture(
  tabId: number,
  finalUrl: string,
  locations: string[] = [],
  { since }: { since?: number } = {}
): Promise<ApiCapture> {
  const records = captureRecords(listNetworkRecords(tabId, 500), since);
  const bodies = new Map<string, string | undefined>();
  // response bodies for the newest data requests first: they are what the run did
  for (const record of [...records].reverse()) {
    if (bodies.size >= MAX_BODIES) break;
    const wanted =
      DATA_TYPES.has(record.resource_type || "other") &&
      record.finished_at &&
      !record.error_text &&
      TEXT_TYPE.test(record.mime_type || "");
    if (!wanted) continue;
    const detail = await networkRecordDetail(tabId, record.request_id, true).catch(() => undefined);
    bodies.set(
      record.request_id,
      typeof detail?.body === "string" ? (detail.base64_encoded ? decodeBase64Text(detail.body) : detail.body) : undefined
    );
  }
  const exchanges = records.map((record, index) => exchangeFrom(record, index, bodies.get(record.request_id)));
  const origins = cookieOrigins(finalUrl, records);
  const cookieReply = await cdpCommand<{ cookies?: Array<Record<string, unknown>> }>(tabId, "Network.getCookies", { urls: origins.length ? origins : [finalUrl] }).catch(() => ({ cookies: [] }));
  const cookies = (cookieReply.cookies || [])
    .filter((cookie) => typeof cookie.name === "string" && typeof cookie.value === "string")
    .map((cookie) => ({
      name: String(cookie.name),
      value: String(cookie.value),
      domain: String(cookie.domain || ""),
      path: String(cookie.path || "/"),
      expires: typeof cookie.expires === "number" ? cookie.expires : -1,
      httpOnly: cookie.httpOnly === true,
      secure: cookie.secure === true,
      ...(typeof cookie.sameSite === "string" ? { sameSite: cookie.sameSite } : {})
    }));
  const storageValue = await evaluatePageExpression(tabId, STORAGE_EXPRESSION, 4_000_000).catch(() => undefined);
  const storage: Record<string, string> = {};
  if (storageValue?.value && typeof storageValue.value === "object") {
    for (const [key, value] of Object.entries(storageValue.value as Record<string, unknown>)) {
      if (typeof value === "string") storage[key] = value;
    }
  }
  return {
    capture_version: 1,
    final_url: finalUrl,
    locations: locations.length ? locations : [finalUrl],
    exchanges,
    cookies,
    storage
  };
}

/**
 * Hosts of one load-balanced service (Algolia's APPID-dsn.algolia.net and
 * APPID-3.algolianet.com): an app-id-like first label up to a -dsn or -N
 * suffix, and a domain name that starts the same. The Bridge's siblingHosts.
 */
export function siblingHosts(a: string, b: string): boolean {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left === right) return true;
  const split = (host: string) => {
    const labels = host.split(".");
    return { stem: labels[0].replace(/-(dsn|\d{1,2})$/, ""), domain: labels.slice(1, -1).join(".") || labels[labels.length - 1] };
  };
  const one = split(left);
  const two = split(right);
  if (one.stem !== two.stem || !/^[a-z0-9]{6,}$/.test(one.stem) || !/\d/.test(one.stem) || !/[a-z]/.test(one.stem)) return false;
  let shared = 0;
  while (shared < one.domain.length && one.domain[shared] === two.domain[shared]) shared++;
  return shared >= 5;
}

/**
 * Whether a recorded request looks like the operation's own: method, host and
 * path segment by segment, where `*` (the Bridge matcher's wildcard) or a
 * `{hole}` stands for any one segment. The Bridge does the real match.
 */
export function looksLikeOperation(record: Pick<NetworkRecord, "method" | "url">, match: { method?: string; host?: string; path?: string }): boolean {
  if (!match.path) return false;
  if (match.method && record.method.toUpperCase() !== match.method.toUpperCase()) return false;
  let url: URL;
  try {
    url = new URL(record.url);
  } catch {
    return false;
  }
  if (match.host && !siblingHosts(match.host, url.hostname)) return false;
  const want = match.path.split("/");
  const got = url.pathname.split("/");
  return want.length === got.length && want.every((segment, index) => segment === "*" || /^\{[^{}]*\}$/.test(segment) || segment === got[index]);
}

/**
 * Waits until the page has finished a request that looks like the operation's,
 * then a short quiet; without one, the usual network quiet. Saves the full
 * quiet wait when the page makes its request early.
 */
export async function waitForOperationRequest(tabId: number, match: { method?: string; host?: string; path?: string }, timeoutMs = 15_000, seen = 0): Promise<number> {
  const started = Date.now();
  const finished = () => listNetworkRecords(tabId, 500).filter((record) => (record.finished_at || record.error_text) && looksLikeOperation(record, match)).length;
  while (Date.now() - started < timeoutMs) {
    // `seen`: how many the caller already judged; wait for one more
    if (finished() > seen) {
      await waitForNetworkQuiet(tabId, 250, 2000);
      return finished();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await waitForNetworkQuiet(tabId, 1200, 5000);
  return finished();
}
