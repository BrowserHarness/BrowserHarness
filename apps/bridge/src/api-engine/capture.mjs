// BrowserHarness network captures (from the extension's CDP capture) as the
// upstream learner's CaptureResult. Cookie values and page storage arrive only
// to tell credentials from parameters; they are dropped after the call.

const MAX_EXCHANGES = 400;
const MAX_BODY_CHARS = 2_000_000;

function lowerHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== "object") return out;
  for (const [key, value] of Object.entries(headers)) {
    if (typeof key !== "string" || key.startsWith(":")) continue;
    out[key.toLowerCase()] = String(value);
  }
  return out;
}

const RESOURCE = {
  document: "document",
  xhr: "xhr",
  fetch: "fetch",
  script: "script",
  stylesheet: "stylesheet",
  image: "image",
  font: "font",
  media: "media",
  websocket: "websocket",
  eventsource: "eventsource",
  manifest: "manifest",
  ping: "ping",
  preflight: "preflight",
  cspviolationreport: "cspviolationreport",
  texttrack: "texttrack",
  other: "other"
};

function cookie(raw) {
  if (!raw || typeof raw.name !== "string" || typeof raw.value !== "string") return undefined;
  return {
    name: raw.name,
    value: raw.value,
    domain: String(raw.domain || ""),
    path: String(raw.path || "/"),
    expires: typeof raw.expires === "number" ? raw.expires : -1,
    httpOnly: raw.httpOnly === true,
    secure: raw.secure === true,
    ...(raw.sameSite === "Strict" || raw.sameSite === "Lax" || raw.sameSite === "None" ? { sameSite: raw.sameSite } : {})
  };
}

/** One run of a page (a trigger, a demonstration) in upstream's CaptureResult shape. */
export function toCaptureResult(capture) {
  if (!capture || typeof capture !== "object" || !Array.isArray(capture.exchanges)) {
    throw new Error("API_CAPTURE_INVALID: a capture needs exchanges");
  }
  const exchanges = [];
  for (const [index, raw] of capture.exchanges.slice(0, MAX_EXCHANGES).entries()) {
    if (!raw?.request?.url || !raw.request.method) continue;
    const responseHeaders = lowerHeaders(raw.response?.headers);
    const body = typeof raw.response?.body === "string" ? raw.response.body.slice(0, MAX_BODY_CHARS) : undefined;
    exchanges.push({
      id: Number.isInteger(raw.id) ? raw.id : index + 1,
      resourceType: RESOURCE[String(raw.resource_type || "other").toLowerCase()] || "other",
      request: {
        method: String(raw.request.method).toUpperCase(),
        url: String(raw.request.url),
        headers: lowerHeaders(raw.request.headers),
        ...(typeof raw.request.body === "string" ? { body: raw.request.body } : {})
      },
      ...(raw.response && typeof raw.response.status === "number"
        ? {
            response: {
              status: raw.response.status,
              headers: responseHeaders,
              ...(body !== undefined ? { body } : {}),
              contentType: String(raw.response.content_type || responseHeaders["content-type"] || "")
            }
          }
        : {}),
      ...(raw.aborted === true ? { aborted: true } : {})
    });
  }
  const storage = {};
  if (capture.storage && typeof capture.storage === "object") {
    for (const [key, value] of Object.entries(capture.storage).slice(0, 500)) {
      if (typeof value === "string") storage[key] = value.slice(0, 20_000);
    }
  }
  return {
    exchanges,
    cookies: (Array.isArray(capture.cookies) ? capture.cookies : []).map(cookie).filter(Boolean),
    finalUrl: String(capture.final_url || exchanges.find((e) => e.resourceType === "document")?.request.url || ""),
    storage,
    locations: Array.isArray(capture.locations) ? capture.locations.filter((item) => typeof item === "string").slice(0, 50) : []
  };
}

/** A capture with every credential-bearing part removed, for logs and evidence. */
export function captureSummary(result) {
  return {
    final_url: result.finalUrl ? new URL(result.finalUrl).origin + new URL(result.finalUrl).pathname : "",
    exchanges: result.exchanges.length,
    cookies: result.cookies.length,
    storage_keys: Object.keys(result.storage || {}).length
  };
}
