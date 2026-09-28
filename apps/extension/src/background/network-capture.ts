import {
  cdpCommand,
  subscribeCdpEvents
} from "./cdp-manager";

export interface NetworkRecord {
  request_id: string;
  url: string;
  method: string;
  request_headers?: Record<string, string>;
  post_data?: string;
  status?: number;
  status_text?: string;
  mime_type?: string;
  response_headers?: Record<string, string>;
  encoded_data_length?: number;
  error_text?: string;
  started_at: number;
  finished_at?: number;
}

interface NetworkSession {
  started_at: number;
  max_entries: number;
  order: string[];
  records: Map<string, NetworkRecord>;
}

const sessions = new Map<number, NetworkSession>();

function headers(
  value: unknown
): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(
    value as Record<string, unknown>
  )) {
    result[key] = String(raw);
  }
  return result;
}

function ensureCapacity(session: NetworkSession) {
  while (session.order.length > session.max_entries) {
    const oldest = session.order.shift();
    if (oldest) session.records.delete(oldest);
  }
}

subscribeCdpEvents((tabId, method, params) => {
  const session = sessions.get(tabId);
  if (!session || !params) return;
  const payload = params as Record<string, any>;

  if (method === "Network.requestWillBeSent") {
    const requestId = String(payload.requestId || "");
    if (!requestId) return;

    const request = payload.request || {};
    const existing = session.records.get(requestId);
    const record: NetworkRecord = {
      request_id: requestId,
      url: String(request.url || existing?.url || ""),
      method: String(request.method || existing?.method || "GET"),
      request_headers:
        headers(request.headers) || existing?.request_headers,
      ...(typeof request.postData === "string"
        ? { post_data: request.postData }
        : {}),
      started_at:
        existing?.started_at ||
        Math.round(Number(payload.wallTime || Date.now() / 1000) * 1000)
    };

    if (!existing) session.order.push(requestId);
    session.records.set(requestId, {
      ...existing,
      ...record
    });
    ensureCapacity(session);

    if (
      request.hasPostData === true &&
      typeof request.postData !== "string"
    ) {
      void cdpCommand<{ postData?: string }>(
        tabId,
        "Network.getRequestPostData",
        { requestId }
      )
        .then((detail) => {
          if (typeof detail.postData !== "string") return;
          const currentSession = sessions.get(tabId);
          const current = currentSession?.records.get(requestId);
          if (!current) return;
          currentSession!.records.set(requestId, {
            ...current,
            post_data: detail.postData
          });
        })
        .catch(() => undefined);
    }

    return;
  }

  if (method === "Network.requestWillBeSentExtraInfo") {
    const requestId = String(payload.requestId || "");
    const record = session.records.get(requestId);
    if (!record) return;

    const extraHeaders = headers(payload.headers);
    if (!extraHeaders) return;

    session.records.set(requestId, {
      ...record,
      request_headers: {
        ...(record.request_headers || {}),
        ...extraHeaders
      }
    });
    return;
  }

  if (method === "Network.responseReceived") {
    const requestId = String(payload.requestId || "");
    const record = session.records.get(requestId);
    if (!record) return;

    const response = payload.response || {};
    session.records.set(requestId, {
      ...record,
      status:
        typeof response.status === "number"
          ? response.status
          : record.status,
      status_text:
        typeof response.statusText === "string"
          ? response.statusText
          : record.status_text,
      mime_type:
        typeof response.mimeType === "string"
          ? response.mimeType
          : record.mime_type,
      response_headers:
        headers(response.headers) || record.response_headers
    });
    return;
  }

  if (method === "Network.loadingFinished") {
    const requestId = String(payload.requestId || "");
    const record = session.records.get(requestId);
    if (!record) return;
    session.records.set(requestId, {
      ...record,
      encoded_data_length:
        typeof payload.encodedDataLength === "number"
          ? payload.encodedDataLength
          : record.encoded_data_length,
      finished_at: Date.now()
    });
    return;
  }

  if (method === "Network.loadingFailed") {
    const requestId = String(payload.requestId || "");
    const record = session.records.get(requestId);
    if (!record) return;
    session.records.set(requestId, {
      ...record,
      error_text:
        typeof payload.errorText === "string"
          ? payload.errorText
          : "Network request failed",
      finished_at: Date.now()
    });
  }
});

export async function startNetworkCapture(
  tabId: number,
  maxEntries = 500
): Promise<void> {
  await cdpCommand(tabId, "Network.enable", {
    maxTotalBufferSize: 25_000_000,
    maxResourceBufferSize: 10_000_000,
    maxPostDataSize: 1_000_000
  });

  sessions.set(tabId, {
    started_at: Date.now(),
    max_entries: Math.min(Math.max(maxEntries, 50), 2000),
    order: [],
    records: new Map()
  });
}

export function listNetworkRecords(
  tabId: number,
  limit = 100
): NetworkRecord[] {
  const session = sessions.get(tabId);
  if (!session) {
    throw new Error("Network capture is not active for this tab");
  }

  const ids = session.order.slice(
    -Math.min(Math.max(limit, 1), 500)
  );
  return ids
    .map((id) => session.records.get(id))
    .filter((record): record is NetworkRecord => Boolean(record));
}

export async function networkRecordDetail(
  tabId: number,
  requestId: string,
  includeBody = true
): Promise<NetworkRecord & {
  body?: string;
  base64_encoded?: boolean;
}> {
  const session = sessions.get(tabId);
  if (!session) {
    throw new Error("Network capture is not active for this tab");
  }

  const record = session.records.get(requestId);
  if (!record) {
    throw new Error("Unknown network request id");
  }

  if (!includeBody || !record.finished_at || record.error_text) {
    return record;
  }

  try {
    const body = await cdpCommand<{
      body?: string;
      base64Encoded?: boolean;
    }>(tabId, "Network.getResponseBody", {
      requestId
    });

    return {
      ...record,
      ...(typeof body.body === "string" ? { body: body.body } : {}),
      base64_encoded: Boolean(body.base64Encoded)
    };
  } catch {
    return record;
  }
}

export async function stopNetworkCapture(
  tabId: number
): Promise<{ captured: number }> {
  const captured = sessions.get(tabId)?.records.size || 0;
  sessions.delete(tabId);
  await cdpCommand(tabId, "Network.disable").catch(() => undefined);
  return { captured };
}

export function networkCaptureActive(tabId: number): boolean {
  return sessions.has(tabId);
}
