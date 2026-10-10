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

/** Reads the run's capture from the tab's active network capture. */
export async function collectApiCapture(tabId: number, finalUrl: string, locations: string[] = []): Promise<ApiCapture> {
  const records = listNetworkRecords(tabId, 500);
  const exchanges: ApiCaptureExchange[] = [];
  let bodies = 0;
  for (const [index, record] of records.entries()) {
    let body: string | undefined;
    const wanted =
      DATA_TYPES.has(record.resource_type || "other") &&
      record.finished_at &&
      !record.error_text &&
      TEXT_TYPE.test(record.mime_type || "") &&
      bodies < MAX_BODIES;
    if (wanted) {
      bodies += 1;
      const detail = await networkRecordDetail(tabId, record.request_id, true).catch(() => undefined);
      if (typeof detail?.body === "string") {
        body = detail.base64_encoded ? decodeBase64Text(detail.body) : detail.body;
      }
    }
    exchanges.push(exchangeFrom(record, index, body));
  }
  const origins = [...new Set(records.map((record) => {
    try {
      return new URL(record.url).origin;
    } catch {
      return "";
    }
  }).filter((origin) => /^https?:/.test(origin)))].slice(0, 20);
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

/** Whether a recorded request looks like the operation's own (method and path; the Bridge does the real match). */
export function looksLikeOperation(record: Pick<NetworkRecord, "method" | "url">, match: { method?: string; path?: string }): boolean {
  if (!match.path) return false;
  if (match.method && record.method.toUpperCase() !== match.method.toUpperCase()) return false;
  let pathname: string;
  try {
    pathname = new URL(record.url).pathname;
  } catch {
    return false;
  }
  const pattern = match.path
    .split(/(\{[^{}]*\})/)
    .map((part) => (/^\{[^{}]*\}$/.test(part) ? "[^/]+" : part.replace(/[.*+?^$()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${pattern}$`).test(pathname);
}

/**
 * Waits until the page has finished a request that looks like the operation's,
 * then a short quiet; without one, the usual network quiet. Saves the full
 * quiet wait when the page makes its request early.
 */
export async function waitForOperationRequest(tabId: number, match: { method?: string; path?: string }, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const records = listNetworkRecords(tabId, 500);
    if (records.some((record) => (record.finished_at || record.error_text) && looksLikeOperation(record, match))) {
      await waitForNetworkQuiet(tabId, 250, 2000);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await waitForNetworkQuiet(tabId, 1200, 5000);
}
