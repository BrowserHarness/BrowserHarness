import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bridge: vi.fn(),
  evaluate: vi.fn(),
  cdp: vi.fn(async () => ({ cookies: [] })),
  landing: [] as string[]
}));

vi.mock("./bridge-client", () => ({ requestBridgeApi: mocks.bridge }));
vi.mock("./page-evaluate", () => ({ evaluatePageExpression: mocks.evaluate }));
vi.mock("./cdp-manager", () => ({ cdpCommand: mocks.cdp }));
vi.mock("./navigation", () => ({ waitForTabUsable: vi.fn(async () => ({})) }));
vi.mock("./network-capture", () => ({ startNetworkCapture: vi.fn(async () => undefined), stopNetworkCapture: vi.fn(async () => undefined), listNetworkRecords: vi.fn(() => []), networkRecordDetail: vi.fn() }));
const capturing = vi.hoisted(() => ({
  wait: vi.fn(async (_tab: number, _match: unknown, _timeout: number, seen = 0) => seen + 1),
  collect: vi.fn(async () => ({ capture_version: 1, final_url: "https://shop.example/search?q=x", locations: [], exchanges: [], cookies: [{ name: "sid", value: "v" }], storage: { k: "v" } }))
}));
vi.mock("./api-capture", () => ({ waitForOperationRequest: capturing.wait, collectApiCapture: capturing.collect }));

import { runTier2, runTier3, TIER2_PAGES } from "./api-transports";
import { searchContract } from "../runtime/api-recipe.fixture";

let opened: string[];
beforeEach(() => {
  opened = [];
  mocks.bridge.mockReset();
  mocks.evaluate.mockReset();
  let next = 0;
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      tabs: {
        create: vi.fn(async ({ url }: { url: string }) => {
          opened.push(url);
          return { id: 100 + next++ };
        }),
        // where each opened tab ended up
        get: vi.fn(async (id: number) => ({ id, url: mocks.landing[id - 100] })),
        remove: vi.fn(async () => undefined),
        update: vi.fn(async () => undefined)
      }
    }
  });
});

describe("tier 2 sends only from a page of the site", () => {
  it("never sends from a page that left the site, and tries the home page next", async () => {
    mocks.landing = ["https://login.other.example/robots", "https://shop.example/"];
    mocks.evaluate.mockImplementation(async (_tab: number, expression: string) =>
      expression.includes("fetch(") ? { value: { status: 200, headers: {}, body: "{}" } } : { value: {} }
    );
    mocks.bridge.mockImplementation(async (action: string) =>
      action === "page_request"
        ? { ok: true, data: { request: { url: "https://shop.example/api/search?q=x", method: "GET", headers: {} } } }
        : { ok: true, data: { ok: true, class: "ok", tier: 2, data: [1], item_count: 1, fetched_at: "", fresh: true } }
    );
    const answer = await runTier2(searchContract(), { q: "x" }, false);
    expect(opened).toEqual(TIER2_PAGES.map((path) => `https://shop.example${path}`));
    expect(answer).toMatchObject({ ok: true, tier: 2 });
    expect(mocks.bridge.mock.calls.map((call) => call[0])).toEqual(["page_request", "page_answer"]);
  });

  it("is unavailable, with nothing sent, when no page stays on the site", async () => {
    mocks.landing = ["chrome-error://chromewebdata/", "https://challenge.cdn.example/"];
    const answer = await runTier2({ ...searchContract(), side_effect: "write" }, { q: "x" }, true);
    expect(answer).toMatchObject({ ok: false, class: "unavailable", sent: false, tier: 2 });
    expect(mocks.bridge).not.toHaveBeenCalled();
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
});

describe("tier 3 watches for the request that carries the inputs", () => {
  it("keeps watching while the page has sent only its default query, then answers with the real one (RC2 N4: GBIF)", async () => {
    mocks.landing = ["https://shop.example/search?q=x"];
    let runs = 0;
    mocks.bridge.mockImplementation(async (action: string, payload: { capture?: { cookies: unknown[]; storage: object } }) => {
      if (action === "page_trigger") return { ok: true, data: { url: "https://shop.example/search?q=x" } };
      runs += 1;
      // nothing private goes to the Bridge for tier 3
      expect(payload.capture?.cookies).toEqual([]);
      expect(payload.capture?.storage).toEqual({});
      return runs === 1
        ? { ok: true, data: { ok: false, class: "endpoint_drift", tier: 3, sent: true, reason: "no inputs yet", awaiting_request: true, fetched_at: "", fresh: true } }
        : { ok: true, data: { ok: true, class: "ok", tier: 3, sent: true, data: [1], item_count: 1, fetched_at: "", fresh: true } };
    });
    const answer = await runTier3(searchContract(), { q: "x" });
    expect(answer).toMatchObject({ ok: true, tier: 3 });
    expect(answer).not.toHaveProperty("awaiting_request");
    expect(capturing.wait.mock.calls.map((call) => call[3])).toEqual([0, 1]);
  });
});
