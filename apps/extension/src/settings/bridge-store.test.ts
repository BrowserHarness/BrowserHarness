import { describe, expect, it, vi } from "vitest";
import {
  bridgePermissionUrl,
  isRemoteBridgeAddress,
  normalizeBridgeAddress,
  saveBridgeSettings
} from "./bridge-store";

describe("Local Bridge address safety", () => {
  it("normalizes the default loopback WebSocket path", () => {
    expect(
      normalizeBridgeAddress("ws://127.0.0.1:10087")
    ).toBe("ws://127.0.0.1:10087/ws");
  });

  it("accepts localhost but rejects plain ws:// to remote hosts", () => {
    expect(
      normalizeBridgeAddress("ws://localhost:10087/ws")
    ).toBe("ws://localhost:10087/ws");
    expect(() =>
      normalizeBridgeAddress("ws://example.com:10087/ws")
    ).toThrow("loopback");
  });

  it("rejects non-WebSocket schemes", () => {
    expect(() =>
      normalizeBridgeAddress("https://127.0.0.1:10087/ws")
    ).toThrow("ws://");
  });

  it("allows a remote Bridge only over wss://", () => {
    expect(
      normalizeBridgeAddress("wss://bridge.example.com")
    ).toBe("wss://bridge.example.com/ws");
    expect(isRemoteBridgeAddress("wss://bridge.example.com/ws")).toBe(true);
    expect(isRemoteBridgeAddress("ws://127.0.0.1:10087/ws")).toBe(false);
  });

  it("derives an https origin for a remote Bridge", () => {
    expect(
      bridgePermissionUrl("wss://bridge.example.com:8443/ws")
    ).toBe("https://bridge.example.com:8443/");
  });

  it("refuses to save a remote Bridge with a short token", async () => {
    const set = vi.fn();
    vi.stubGlobal("chrome", { storage: { local: { set } } });
    await expect(
      saveBridgeSettings({
        enabled: true,
        address: "wss://bridge.example.com/ws",
        token: "short"
      })
    ).rejects.toThrow("at least 32");
    await saveBridgeSettings({
      enabled: true,
      address: "wss://bridge.example.com/ws",
      token: "t".repeat(40)
    });
    expect(set).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("derives a least-privilege HTTP origin for Chrome host permission", () => {
    expect(
      bridgePermissionUrl("ws://127.0.0.1:10087/ws")
    ).toBe("http://127.0.0.1:10087/");
  });
});
