import { describe, expect, it } from "vitest";
import {
  bridgePermissionUrl,
  normalizeBridgeAddress
} from "./bridge-store";

describe("Local Bridge address safety", () => {
  it("normalizes the default loopback WebSocket path", () => {
    expect(
      normalizeBridgeAddress("ws://127.0.0.1:10087")
    ).toBe("ws://127.0.0.1:10087/ws");
  });

  it("accepts localhost but rejects remote hosts", () => {
    expect(
      normalizeBridgeAddress("ws://localhost:10087/ws")
    ).toBe("ws://localhost:10087/ws");
    expect(() =>
      normalizeBridgeAddress("ws://example.com:10087/ws")
    ).toThrow("loopback");
  });

  it("rejects secure or non-WebSocket schemes in the local bridge field", () => {
    expect(() =>
      normalizeBridgeAddress("https://127.0.0.1:10087/ws")
    ).toThrow("ws://");
  });

  it("derives a least-privilege HTTP origin for Chrome host permission", () => {
    expect(
      bridgePermissionUrl("ws://127.0.0.1:10087/ws")
    ).toBe("http://127.0.0.1:10087/");
  });
});
