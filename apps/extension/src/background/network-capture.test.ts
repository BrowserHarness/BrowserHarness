import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const listeners: Array<
    (tabId: number, method: string, params?: object) => void
  > = [];
  return {
    cdpCommand: vi.fn(),
    listeners,
    subscribe: vi.fn((listener) => {
      listeners.push(listener);
      return () => undefined;
    })
  };
});

vi.mock("./cdp-manager", () => ({
  cdpCommand: mocks.cdpCommand,
  subscribeCdpEvents: mocks.subscribe
}));

import {
  listNetworkRecords,
  networkRecordDetail,
  startNetworkCapture,
  stopNetworkCapture
} from "./network-capture";

function emit(tabId: number, method: string, params: object) {
  for (const listener of mocks.listeners) {
    listener(tabId, method, params);
  }
}

describe("CDP network capture", () => {
  beforeEach(() => {
    mocks.cdpCommand.mockReset();
    mocks.cdpCommand.mockResolvedValue({});
  });

  it("captures request and response lifecycle metadata", async () => {
    await startNetworkCapture(1, 100);

    emit(1, "Network.requestWillBeSent", {
      requestId: "r1",
      wallTime: 100,
      request: {
        url: "https://example.com/api",
        method: "POST",
        headers: { "x-test": "1" },
        postData: "{\"hello\":true}"
      }
    });

    emit(1, "Network.responseReceived", {
      requestId: "r1",
      response: {
        status: 201,
        statusText: "Created",
        mimeType: "application/json",
        headers: { "content-type": "application/json" }
      }
    });

    emit(1, "Network.loadingFinished", {
      requestId: "r1",
      encodedDataLength: 321
    });

    expect(listNetworkRecords(1)).toEqual([
      expect.objectContaining({
        request_id: "r1",
        url: "https://example.com/api",
        method: "POST",
        status: 201,
        mime_type: "application/json",
        encoded_data_length: 321
      })
    ]);
  });

  it("merges requestWillBeSentExtraInfo headers into the request record", async () => {
    await startNetworkCapture(4, 100);

    emit(4, "Network.requestWillBeSent", {
      requestId: "r4",
      request: {
        url: "https://example.com/api",
        method: "GET",
        headers: {
          accept: "application/json"
        }
      }
    });

    emit(4, "Network.requestWillBeSentExtraInfo", {
      requestId: "r4",
      headers: {
        cookie: "session=abc",
        "x-csrf-token": "token-1"
      }
    });

    expect(listNetworkRecords(4)[0].request_headers).toEqual({
      accept: "application/json",
      cookie: "session=abc",
      "x-csrf-token": "token-1"
    });
  });

  it("retrieves request post data when the initial event omits it", async () => {
    await startNetworkCapture(5, 100);

    mocks.cdpCommand.mockImplementation(async (_tab, method) => {
      if (method === "Network.getRequestPostData") {
        return {
          postData: "email=user%40example.com"
        };
      }
      return {};
    });

    emit(5, "Network.requestWillBeSent", {
      requestId: "r5",
      request: {
        url: "https://example.com/submit",
        method: "POST",
        hasPostData: true
      }
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(listNetworkRecords(5)[0].post_data).toBe(
      "email=user%40example.com"
    );
    expect(mocks.cdpCommand).toHaveBeenCalledWith(
      5,
      "Network.getRequestPostData",
      { requestId: "r5" }
    );
  });

  it("retrieves a finished response body through CDP", async () => {
    await startNetworkCapture(2, 100);
    emit(2, "Network.requestWillBeSent", {
      requestId: "r2",
      request: {
        url: "https://example.com/data",
        method: "GET"
      }
    });
    emit(2, "Network.loadingFinished", {
      requestId: "r2",
      encodedDataLength: 12
    });

    mocks.cdpCommand.mockImplementation(async (_tab, method) => {
      if (method === "Network.getResponseBody") {
        return {
          body: "{\"ok\":true}",
          base64Encoded: false
        };
      }
      return {};
    });

    const detail = await networkRecordDetail(2, "r2", true);

    expect(detail).toEqual(
      expect.objectContaining({
        request_id: "r2",
        body: "{\"ok\":true}",
        base64_encoded: false
      })
    );
  });

  it("stops capture and disables the Network domain", async () => {
    await startNetworkCapture(3, 100);
    emit(3, "Network.requestWillBeSent", {
      requestId: "r3",
      request: {
        url: "https://example.com",
        method: "GET"
      }
    });

    await expect(stopNetworkCapture(3)).resolves.toEqual({
      captured: 1
    });

    expect(mocks.cdpCommand).toHaveBeenCalledWith(
      3,
      "Network.disable"
    );
    expect(() => listNetworkRecords(3)).toThrow(
      "not active"
    );
  });
});
