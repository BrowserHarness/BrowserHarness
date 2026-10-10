import { describe, expect, it, vi } from "vitest";
import { dispatchApiOperation, mayTryNext, tierOrder, type ApiDispatchDeps } from "./api-dispatch";
import { searchContract } from "./api-recipe.fixture";
import type { ApiCallResult, ApiResultClass, ApiTier } from "./api-recipe";

function answer(tier: ApiTier, cls: ApiResultClass, extra: Partial<ApiCallResult> = {}): ApiCallResult {
  return {
    ok: cls === "ok",
    class: cls,
    tier,
    ...(cls === "ok" ? { data: [{ id: `from-${tier}` }], item_count: 1 } : { reason: cls }),
    fetched_at: "2026-10-10T00:00:00.000Z",
    fresh: true,
    ...extra
  };
}

function deps(script: Partial<Record<ApiTier, ApiCallResult | Error>>, remembered?: ApiTier) {
  const remember = vi.fn(async () => undefined);
  const run = vi.fn(async (tier: ApiTier) => {
    const next = script[tier];
    if (next instanceof Error) throw next;
    return next || answer(tier, "unavailable", { sent: false });
  });
  const value: ApiDispatchDeps = { run, remembered: vi.fn(async () => remembered), remember };
  return { deps: value, run, remember };
}

const read = { ...searchContract(), transport: { preference: [1, 2, 3] as ApiTier[] } };
const write = { ...read, side_effect: "write" as const };

describe("hybrid dispatch", () => {
  it("orders tiers cheapest first, the remembered one first, never below min_tier", () => {
    expect(tierOrder(read)).toEqual([1, 2, 3]);
    expect(tierOrder(read, 2)).toEqual([2, 1, 3]);
    expect(tierOrder({ ...read, min_tier: 3 })).toEqual([3]);
    expect(tierOrder({ ...read, transport: { preference: [1, 2, 3], learned_tier: 3 } })).toEqual([3, 1, 2]);
    expect(tierOrder(read, undefined, 2)).toEqual([1, 2]);
  });

  it("a signed-in read moves from plain HTTP to the page, and the page tier is remembered", async () => {
    const { deps: d, run, remember } = deps({ 1: answer(1, "auth", { sent: true, status: 401 }), 2: answer(2, "ok", { sent: true }) });
    const result = await dispatchApiOperation(d, read, { q: "monitors" });
    expect(result).toMatchObject({ ok: true, tier: 2, data: [{ id: "from-2" }] });
    expect(result.attempts.map((item) => [item.tier, item.class])).toEqual([
      [1, "auth"],
      [2, "ok"]
    ]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(remember).toHaveBeenCalledWith(read.operation_id, 2);
  });

  it("starts with the remembered tier next time", async () => {
    const { deps: d, run } = deps({ 2: answer(2, "ok") }, 2);
    await dispatchApiOperation(d, read, { q: "x" });
    expect(run.mock.calls.map((call) => call[0])).toEqual([2]);
  });

  it("stops on input, rate limits and drift instead of trying elsewhere", async () => {
    for (const cls of ["input", "rate_limited", "schema_drift", "endpoint_drift", "approval_required"] as const) {
      const { deps: d, run } = deps({ 1: answer(1, cls) });
      const result = await dispatchApiOperation(d, read, {});
      expect(result.class).toBe(cls);
      expect(run).toHaveBeenCalledTimes(1);
    }
  });

  it("a blocked read gets past the bot check in the page (tier 3)", async () => {
    const { deps: d } = deps({ 1: answer(1, "blocked"), 2: answer(2, "blocked"), 3: answer(3, "ok") });
    const result = await dispatchApiOperation(d, read, {});
    expect(result.tier).toBe(3);
    expect(result.attempts).toHaveLength(3);
  });

  it("a write that reached the site is never sent again, whatever came back", async () => {
    for (const cls of ["ambiguous_write", "auth", "blocked", "network", "schema_drift"] as const) {
      const { deps: d, run } = deps({ 1: answer(1, cls, { sent: true }), 2: answer(2, "ok") });
      const result = await dispatchApiOperation(d, write, {}, { approved: true });
      expect(result.ok).toBe(false);
      expect(run).toHaveBeenCalledTimes(1);
    }
  });

  it("a write that nothing sent may go to the next tier once", async () => {
    const { deps: d, run } = deps({ 1: answer(1, "unavailable", { sent: false }), 2: answer(2, "ok", { sent: true }) });
    const result = await dispatchApiOperation(d, write, {}, { approved: true });
    expect(result).toMatchObject({ ok: true, tier: 2 });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("a transport that throws during a write counts as an ambiguous write", async () => {
    const { deps: d, run } = deps({ 1: new Error("socket hang up"), 2: answer(2, "ok") });
    const result = await dispatchApiOperation(d, write, {}, { approved: true });
    expect(result).toMatchObject({ ok: false, class: "ambiguous_write", next: expect.stringMatching(/do not resend/) });
    expect(run).toHaveBeenCalledTimes(1);
    expect(mayTryNext(write, result)).toBe(false);
  });

  it("a write without approval is refused by the first tier and goes no further", async () => {
    const { deps: d, run } = deps({ 1: answer(1, "approval_required", { sent: false }) });
    const result = await dispatchApiOperation(d, write, {});
    expect(result.class).toBe("approval_required");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
