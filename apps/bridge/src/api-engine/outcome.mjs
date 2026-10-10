// One result shape for every transport, and the BrowserHarness failure
// classes (docs/protocols/API-RECIPE-V2.md "Results"). Upstream's classifier
// says ok/drift/auth/rate/blocked/input/error; BrowserHarness splits drift
// (schema vs endpoint) and error (network vs an ambiguous write).
import { createHash } from "node:crypto";

export const FAILURE_CLASSES = [
  "ok",
  "input",
  "auth",
  "rate_limited",
  "blocked",
  "network",
  "schema_drift",
  "endpoint_drift",
  "ambiguous_write",
  "approval_required",
  "unavailable"
];

/** Upstream class plus what was observed, as a BrowserHarness class. */
export function bhClass(upstreamClass, { status, missing, sideEffect, sent } = {}) {
  switch (upstreamClass) {
    case "ok":
      return "ok";
    case "input":
      return "input";
    case "auth":
      return "auth";
    case "rate":
      return "rate_limited";
    case "blocked":
      return "blocked";
    case "drift":
      // the endpoint is gone or moved; otherwise it answered without the data
      if (status === 404 || status === 405 || status === 410 || status === 501) return "endpoint_drift";
      return "schema_drift";
    default:
      // a request that may have reached the server and changed something
      if (sideEffect !== "read" && sent !== false) return "ambiguous_write";
      if (status === 404 || status === 410) return "endpoint_drift";
      return "network";
  }
}

/** How many items a result carries: a list's length, else 1 for a value, 0 for nothing. */
export function itemCount(data) {
  if (data === undefined || data === null) return 0;
  if (Array.isArray(data)) return data.length;
  if (typeof data === "object") {
    const lists = Object.values(data).filter(Array.isArray);
    if (lists.length === 1) return lists[0].length;
    return Object.keys(data).length ? 1 : 0;
  }
  return String(data).trim() ? 1 : 0;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Order-independent digest of extracted data; compares results without keeping them. */
export function dataFingerprint(data) {
  return createHash("sha256").update(canonical(data)).digest("hex").slice(0, 32);
}

/** The fields every API result carries, whichever tier produced it. */
export function result({ ok, cls, tier, status, ms, data, truncated, reason, next, operation_id, fetched_at }) {
  return {
    ok,
    class: cls,
    tier,
    ...(status !== undefined ? { status } : {}),
    ...(ms !== undefined ? { ms } : {}),
    ...(ok ? { data, item_count: itemCount(data) } : {}),
    ...(truncated ? { truncated } : {}),
    ...(reason ? { reason: String(reason).slice(0, 500) } : {}),
    ...(next ? { next } : {}),
    ...(operation_id ? { operation_id } : {}),
    fetched_at: fetched_at || new Date().toISOString(),
    fresh: true
  };
}
