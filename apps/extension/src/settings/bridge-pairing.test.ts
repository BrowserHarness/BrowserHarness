import { describe, expect, it, vi } from "vitest";
import {
  BridgeNotRunningError,
  bridgeHttpBase,
  requestPairing,
  waitForPairing
} from "./bridge-pairing";

const ok = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });

describe("pairing with the Bridge", () => {
  it("talks to the Bridge's http address", () => {
    expect(bridgeHttpBase("ws://127.0.0.1:10087/ws")).toBe("http://127.0.0.1:10087");
    expect(bridgeHttpBase("wss://bridge.example.com/ws")).toBe("https://bridge.example.com");
  });

  it("asks for a code, then receives the token once it is confirmed", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok({ request_id: "r1", code: "123456", expires_at: 1 }))
      .mockResolvedValueOnce(ok({ state: "pending" }))
      .mockResolvedValueOnce(ok({ state: "approved", token: "secret" }));
    const request = await requestPairing("ws://127.0.0.1:10087/ws", fetchImpl);
    expect(request.code).toBe("123456");
    expect(String(fetchImpl.mock.calls[0][0])).toBe("http://127.0.0.1:10087/pair/request");
    const token = await waitForPairing("ws://127.0.0.1:10087/ws", "r1", {
      fetchImpl,
      intervalMs: 1
    });
    expect(token).toBe("secret");
    expect(JSON.parse(String(fetchImpl.mock.calls[2][1]?.body))).toEqual({ request_id: "r1" });
  });

  it("says plainly when the Bridge is not running or the code expired", async () => {
    const down = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(requestPairing(undefined, down)).rejects.toBeInstanceOf(BridgeNotRunningError);
    const expired = vi.fn<typeof fetch>().mockResolvedValue(ok({ state: "expired" }));
    await expect(
      waitForPairing("ws://127.0.0.1:10087/ws", "r1", { fetchImpl: expired })
    ).rejects.toThrow("Press Pair again");
  });
});
