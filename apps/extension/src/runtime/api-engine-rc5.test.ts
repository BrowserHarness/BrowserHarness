// RC5: regressions from the RC4 real-site acceptance (e9c1b73, sabpuja.com).
// Each test reproduces a defect seen there before its fix. Defect numbers are
// those in ACCEPTANCE-RESULTS-e9c1b73.md.
import { describe, expect, it, vi } from "vitest";

vi.mock("../background/cdp-manager", () => ({ cdpCommand: vi.fn(), subscribeCdpEvents: vi.fn(() => () => undefined) }));
vi.mock("../background/page-evaluate", () => ({ evaluatePageExpression: vi.fn() }));
import { dispatchApiOperation, type ApiDispatchDeps } from "./api-dispatch";
import type { ApiCallResult, ApiOperationContract } from "./api-recipe";
import { searchContract } from "./api-recipe.fixture";
import { captureRecords, MAX_CAPTURE_EXCHANGES } from "../background/api-capture";
import { noteWatchStart, takeWatchStart } from "../background/api-watch";
import type { NetworkRecord } from "../background/network-capture";
import type { SiteCommand } from "./site-commands";
import { siteCommandAnswer } from "../ui/site-command-answer";

describe("R5-1: Watch Me learns from what the demonstration did, not the tab's history", () => {
  const record = (index: number, startedAt: number, url = `https://monorail-edge.example/v1/produce?n=${index}`): NetworkRecord => ({
    request_id: `r${index}`,
    url,
    method: "POST",
    resource_type: "fetch",
    started_at: startedAt
  });
  // a tab in use for a while: 490 requests before Record, then the Add to cart and a few after
  const before = Array.from({ length: 490 }, (_, index) => record(index, 1_000 + index));
  const during = [record(490, 10_000, "https://sabpuja.example/cart/add.js"), ...Array.from({ length: 9 }, (_, index) => record(491 + index, 10_001 + index))];

  it("keeps only the requests made since the recording started", () => {
    const kept = captureRecords([...before, ...during], 10_000);
    expect(kept).toHaveLength(10);
    expect(kept[0].url).toBe("https://sabpuja.example/cart/add.js");
  });

  it("over the limit, keeps the newest", () => {
    const kept = captureRecords([...before, ...during]);
    expect(kept.length).toBe(MAX_CAPTURE_EXCHANGES);
    expect(kept.some((item) => item.url.endsWith("/cart/add.js"))).toBe(true);
  });

  it("the recording remembers when it started", () => {
    noteWatchStart("rec-1", 7, false, 12_345);
    expect(takeWatchStart("rec-1")).toEqual({ tab_id: 7, started_capture: false, started_at: 12_345 });
  });
});

describe("R5-3: a signed-out run is a sign-in problem", () => {
  const contract = (): ApiOperationContract => ({ ...searchContract(), name: "orders", origin: "https://shop.example", transport: { preference: [3, 1, 2], learned_tier: 3 } }) as ApiOperationContract;
  const failure = (cls: ApiCallResult["class"], reason: string) =>
    ({ ok: false, class: cls, reason, operation_id: "op", fetched_at: new Date().toISOString(), fresh: true, sent: false }) as ApiCallResult & { sent: boolean };

  it("reports auth when a tier saw the sign-in page, whatever the last tier said", async () => {
    // RC4: tier 3 auth (sign-in page), tier 1 auth (no session value), tier 2 unavailable
    const answers: Record<number, ApiCallResult & { sent: boolean }> = {
      3: failure("auth", "the page went to a sign-in page"),
      1: failure("auth", "no value for session reference(s)"),
      2: failure("unavailable", "a value this operation sends is not in this page's storage")
    };
    const deps: ApiDispatchDeps = {
      run: async (tier) => ({ ...answers[tier], tier }),
      remembered: async () => undefined,
      remember: async () => undefined
    };
    const result = await dispatchApiOperation(deps, contract(), {});
    expect(result.attempts.map((attempt) => `${attempt.tier} ${attempt.class}`)).toEqual(["3 auth", "1 auth", "2 unavailable"]);
    expect(result.ok).toBe(false);
    expect(result.class).toBe("auth");
    expect(result.reason).toMatch(/sign-in page/);
    expect(result.next).toMatch(/sign in/);
  });

  it("keeps unavailable when no tier saw a sign-in", async () => {
    const deps: ApiDispatchDeps = {
      run: async (tier) => ({ ...failure("unavailable", "not in this page's storage"), tier }),
      remembered: async () => undefined,
      remember: async () => undefined
    };
    expect((await dispatchApiOperation(deps, contract(), {})).class).toBe("unavailable");
  });

  it("the side panel says to sign in, not that something is unavailable", () => {
    const command = { name: "shopify-orders", site: "sabpuja.com", kind: "read" } as unknown as SiteCommand;
    const answer = siteCommandAnswer(command, {
      ok: false,
      error: { code: "API_AUTH", message: "API_AUTH: the page went to a sign-in page" }
    });
    expect(answer).toMatch(/not signed in to sabpuja\.com/);
    expect(answer).toMatch(/Sign in/);
    expect(answer).not.toMatch(/unavailable/i);
  });
});
