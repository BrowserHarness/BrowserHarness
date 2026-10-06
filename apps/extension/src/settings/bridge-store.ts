export interface BridgeSettings {
  enabled: boolean;
  address: string;
  token: string;
}

export interface BridgeStatus {
  state: "disabled" | "connecting" | "connected" | "disconnected" | "error";
  message?: string;
  /** Chat apps set up in the Bridge, which can receive scheduled results. */
  chat_apps?: string[];
  changed_at: string;
}

const SETTINGS_KEY = "browserharness.bridgeSettings";
const STATUS_KEY = "browserharness.bridgeStatus";

export const DEFAULT_BRIDGE_SETTINGS: BridgeSettings = {
  enabled: false,
  address: "ws://127.0.0.1:10087/ws",
  token: ""
};

const LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost", "[::1]"];
export const REMOTE_BRIDGE_MIN_TOKEN_LENGTH = 32;

/**
 * Plain ws:// is only allowed for a loopback Bridge. A remote Bridge (our
 * own servers, once they exist) must be reached over wss:// so the pairing
 * token never crosses the network in clear text.
 */
export function normalizeBridgeAddress(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error("BrowserHarness Bridge must use ws:// (loopback) or wss:// (remote)");
  }
  if (
    parsed.protocol === "ws:" &&
    !LOOPBACK_HOSTNAMES.includes(parsed.hostname)
  ) {
    throw new Error(
      "BrowserHarness Bridge must use a loopback address, or wss:// for a remote Bridge"
    );
  }
  if (parsed.pathname !== "/ws") {
    parsed.pathname = "/ws";
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function isRemoteBridgeAddress(address: string): boolean {
  return !LOOPBACK_HOSTNAMES.includes(
    new URL(normalizeBridgeAddress(address)).hostname
  );
}

export function bridgePermissionUrl(address: string): string {
  const parsed = new URL(normalizeBridgeAddress(address));
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export async function loadBridgeSettings(): Promise<BridgeSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return {
    ...DEFAULT_BRIDGE_SETTINGS,
    ...(stored[SETTINGS_KEY] as Partial<BridgeSettings> | undefined)
  };
}

export async function saveBridgeSettings(
  settings: BridgeSettings
): Promise<void> {
  const normalized: BridgeSettings = {
    ...settings,
    address: normalizeBridgeAddress(settings.address),
    token: settings.token.trim()
  };
  if (
    isRemoteBridgeAddress(normalized.address) &&
    normalized.token.length < REMOTE_BRIDGE_MIN_TOKEN_LENGTH
  ) {
    throw new Error(
      `A remote Bridge needs a pairing token of at least ${REMOTE_BRIDGE_MIN_TOKEN_LENGTH} characters`
    );
  }
  await chrome.storage.local.set({ [SETTINGS_KEY]: normalized });
}

export async function loadBridgeStatus(): Promise<BridgeStatus> {
  const stored = await chrome.storage.session.get(STATUS_KEY);
  return (
    (stored[STATUS_KEY] as BridgeStatus | undefined) || {
      state: "disabled",
      changed_at: new Date().toISOString()
    }
  );
}

export async function saveBridgeStatus(
  status: Omit<BridgeStatus, "changed_at">
): Promise<void> {
  await chrome.storage.session.set({
    [STATUS_KEY]: {
      ...status,
      changed_at: new Date().toISOString()
    }
  });
}

export const BRIDGE_SETTINGS_KEY = SETTINGS_KEY;
export const BRIDGE_STATUS_KEY = STATUS_KEY;
