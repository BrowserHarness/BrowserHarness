import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const listeners: Array<(tabId: number, method: string, params?: object) => void> = [];
  return {
    cdpCommand: vi.fn(),
    evaluatePageExpression: vi.fn(),
    listeners,
    subscribe: vi.fn((listener) => {
      listeners.push(listener);
      return () => undefined;
    })
  };
});

vi.mock("./cdp-manager", () => ({ cdpCommand: mocks.cdpCommand, subscribeCdpEvents: mocks.subscribe }));
vi.mock("./page-evaluate", () => ({ evaluatePageExpression: mocks.evaluatePageExpression }));

import { collectApiCapture } from "./api-capture";
import { startNetworkCapture, stopNetworkCapture } from "./network-capture";

function emit(tabId: number, method: string, params: object) {
  for (const listener of mocks.listeners) listener(tabId, method, params);
}

function request(id: string, type: string, url: string, mimeType: string) {
  emit(7, "Network.requestWillBeSent", { requestId: id, type, wallTime: 1, request: { url, method: "GET", headers: { accept: "*/*" } } });
  emit(7, "Network.responseReceived", { requestId: id, response: { status: 200, mimeType, headers: { "content-type": mimeType } } });
  emit(7, "Network.loadingFinished", { requestId: id, encodedDataLength: 10 });
}

describe("API learning capture", () => {
  beforeEach(() => {
    mocks.cdpCommand.mockReset();
    mocks.evaluatePageExpression.mockReset();
  });

  it("records resource types, data bodies, cookies and storage for one learning call", async () => {
    mocks.cdpCommand.mockImplementation(async (_tab: number, method: string, params: { requestId?: string }) => {
      if (method === "Network.getResponseBody") {
        return params.requestId === "b"
          ? { body: btoa('{"items":[1]}'), base64Encoded: true }
          : { body: "<html></html>", base64Encoded: false };
      }
      if (method === "Network.getCookies") {
        return { cookies: [{ name: "sid", value: "s1", domain: "shop.example", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }] };
      }
      return {};
    });
    mocks.evaluatePageExpression.mockResolvedValue({ type: "object", value: { token: "t1", count: 3 } });

    await startNetworkCapture(7, 100);
    request("a", "Document", "https://shop.example/search?q=laptops", "text/html");
    request("b", "Fetch", "https://shop.example/api/search?q=laptops", "application/json");
    request("c", "Image", "https://shop.example/logo.png", "image/png");

    const capture = await collectApiCapture(7, "https://shop.example/search?q=laptops");
    await stopNetworkCapture(7);

    expect(capture.exchanges.map((item) => [item.resource_type, item.response?.body])).toEqual([
      ["document", "<html></html>"],
      ["fetch", '{"items":[1]}'],
      ["image", undefined]
    ]);
    expect(capture.cookies).toEqual([
      { name: "sid", value: "s1", domain: "shop.example", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }
    ]);
    expect(capture.storage).toEqual({ token: "t1" });
    expect(mocks.cdpCommand).toHaveBeenCalledWith(7, "Network.getCookies", { urls: ["https://shop.example"] });
    // an image body is never read
    expect(mocks.cdpCommand.mock.calls.filter(([, method]) => method === "Network.getResponseBody")).toHaveLength(2);
  });
});
