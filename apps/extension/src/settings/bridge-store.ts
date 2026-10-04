export interface BridgeSettings {
  enabled: boolean;
  address: string;
  token: string;
}

export interface BridgeStatus {
  state: "disabled" | "connecting" | "connected" | "disconnected" | "error";
  message?: string;
  changed_at: string;
}

const SETTINGS_KEY = "browsercrew.bridgeSettings";
const STATUS_KEY = "browsercrew.bridgeStatus";

export const DEFAULT_BRIDGE_SETTINGS: BridgeSettings = {
  enabled: false,
  address: "ws://127.0.0.1:10087/ws",
  token: ""
};

export function normalizeBridgeAddress(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "ws:") {
    throw new Error("BrowserHarness Bridge must use ws://");
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) {
    throw new Error("BrowserHarness Bridge must use a loopback address");
  }
  if (parsed.pathname !== "/ws") {
    parsed.pathname = "/ws";
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function bridgePermissionUrl(address: string): string {
  const parsed = new URL(normalizeBridgeAddress(address));
  parsed.protocol = "http:";
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
