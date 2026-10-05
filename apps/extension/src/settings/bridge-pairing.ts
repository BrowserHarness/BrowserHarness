import {
  DEFAULT_BRIDGE_SETTINGS,
  normalizeBridgeAddress
} from "./bridge-store";

export interface PairingRequest {
  request_id: string;
  code: string;
  expires_at: number;
}

export type PairingState =
  | { state: "pending"; expires_at?: number }
  | { state: "approved"; token: string }
  | { state: "denied" }
  | { state: "expired" };

/** http(s) address of the Bridge behind a ws(s):// address. */
export function bridgeHttpBase(address = DEFAULT_BRIDGE_SETTINGS.address): string {
  const parsed = new URL(normalizeBridgeAddress(address));
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  return parsed.origin;
}

export class BridgeNotRunningError extends Error {
  constructor() {
    super("The BrowserHarness Bridge is not running on this computer.");
  }
}

async function post<T>(
  address: string,
  path: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(`${bridgeHttpBase(address)}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000)
    });
  } catch {
    throw new BridgeNotRunningError();
  }
  const payload = (await response.json().catch(() => null)) as
    | { ok?: boolean; data?: T; error?: { message?: string } }
    | null;
  if (!response.ok || !payload?.ok || !payload.data) {
    throw new Error(payload?.error?.message || `The Bridge answered HTTP ${response.status}.`);
  }
  return payload.data;
}

/** Ask the Bridge to pair; it returns the code to confirm in the terminal. */
export function requestPairing(
  address = DEFAULT_BRIDGE_SETTINGS.address,
  fetchImpl: typeof fetch = fetch
): Promise<PairingRequest> {
  return post<PairingRequest>(address, "/pair/request", {}, fetchImpl);
}

export function pairingStatus(
  address: string,
  requestId: string,
  fetchImpl: typeof fetch = fetch
): Promise<PairingState> {
  return post<PairingState>(address, "/pair/status", { request_id: requestId }, fetchImpl);
}

/**
 * Wait until the person confirms the code in the terminal. Resolves with the
 * Bridge token, or rejects when the request is denied, expires or is cancelled.
 */
export async function waitForPairing(
  address: string,
  requestId: string,
  {
    signal,
    intervalMs = 1000,
    fetchImpl = fetch
  }: { signal?: AbortSignal; intervalMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<string> {
  for (;;) {
    if (signal?.aborted) throw new Error("Pairing cancelled.");
    const status = await pairingStatus(address, requestId, fetchImpl);
    if (status.state === "approved") return status.token;
    if (status.state === "denied") throw new Error("Pairing was declined in the terminal.");
    if (status.state === "expired") throw new Error("The code expired. Press Pair again.");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
