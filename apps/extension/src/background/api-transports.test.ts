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
vi.mock("./network-capture", () => ({ startNetworkCapture: vi.fn(), stopNetworkCapture: vi.fn(), listNetworkRecords: vi.fn(() => []), networkRecordDetail: vi.fn() }));

import { runTier2, TIER2_PAGES } from "./api-transports";
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
        remove: vi.fn(async () => undefined)
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
