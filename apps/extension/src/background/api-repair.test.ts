import { describe, expect, it, vi } from "vitest";
import {
  checkApiHealth,
  MAX_REPAIRS_PER_DAY,
  nextForClass,
  recordRepair,
  repairAllowed,
  repairApiOperation,
  REPAIR_COOLDOWN_MS,
  taughtInputs,
  type ApiRepairDeps,
  type RepairLedger
} from "./api-repair";
import { searchContract } from "../runtime/api-recipe.fixture";
import { contractDiff, type ApiCallResult, type ApiOperationContract } from "../runtime/api-recipe";

const taught: ApiOperationContract = {
  ...searchContract(),
  provenance: { ...searchContract().provenance, example_inputs: { learning: [{ q: "laptops" }, { q: "keyboards" }], unseen: { q: "monitors" } } }
};

function ok(items: number): ApiCallResult {
  return { ok: true, class: "ok", tier: 1, data: Array.from({ length: items }, (_, i) => ({ i })), item_count: items, fetched_at: "", fresh: true };
}

describe("API health checks", () => {
  it("calls a read with the taught third input", async () => {
    const dispatch = vi.fn(async () => ok(2));
    const health = await checkApiHealth(dispatch, "r1", taught);
    expect(dispatch).toHaveBeenCalledWith(taught, { q: "monitors" });
    expect(health).toMatchObject({ passed: true, class: "ok", item_count: 2 });
  });

  it("fails on an empty answer or a failure class, and skips writes", async () => {
    expect((await checkApiHealth(async () => ok(0), "r1", taught)).passed).toBe(false);
    const drift = await checkApiHealth(async () => ({ ...ok(0), ok: false, class: "endpoint_drift", reason: "HTTP 404" }), "r1", taught);
    expect(drift).toMatchObject({ passed: false, class: "endpoint_drift", detail: "HTTP 404" });
    const dispatch = vi.fn();
    expect((await checkApiHealth(dispatch, "r1", { ...taught, side_effect: "write" })).class).toBe("skipped");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("falls back to the params' own examples when no taught inputs are kept", () => {
    expect(taughtInputs(searchContract())).toEqual({ learning: [{ q: "laptops" }] });
    const privateContract = { ...searchContract(), params: [{ name: "q", type: "string" as const, required: true }] };
    expect(taughtInputs(privateContract)).toBeNull();
  });
});

describe("API repair", () => {
  const day = 24 * 60 * 60 * 1000;

  it("is bounded: a few a day, a pause after a failure, a gap between attempts", () => {
    let ledger: RepairLedger = {};
    const t0 = 1_000_000_000;
    expect(repairAllowed(ledger, "op", t0).allowed).toBe(true);
    ledger = recordRepair(ledger, "op", "failed", t0);
    expect(repairAllowed(ledger, "op", t0 + 60_000)).toMatchObject({ allowed: false, reason: expect.stringMatching(/failed/) });
    expect(repairAllowed(ledger, "op", t0 + REPAIR_COOLDOWN_MS + 1).allowed).toBe(true);
    for (let i = 1; i < MAX_REPAIRS_PER_DAY; i += 1) ledger = recordRepair(ledger, "op", "repaired", t0 + i * REPAIR_COOLDOWN_MS * 2);
    const late = t0 + MAX_REPAIRS_PER_DAY * REPAIR_COOLDOWN_MS * 2;
    expect(repairAllowed(ledger, "op", late)).toMatchObject({ allowed: false, reason: expect.stringMatching(/in a day/) });
    expect(repairAllowed(ledger, "op", t0 + day + 1).allowed).toBe(true);
    expect(Object.keys(recordRepair(ledger, "other", "repaired", t0 + 3 * day))).toEqual(["other"]);
  });

  function deps(learnResult: Awaited<ReturnType<ApiRepairDeps["learn"]>>, ledger: RepairLedger = {}) {
    const saved: RepairLedger[] = [];
    const value: ApiRepairDeps = {
      learn: vi.fn(async () => learnResult),
      ledger: vi.fn(async () => ledger),
      saveLedger: vi.fn(async (next) => {
        saved.push(next);
      }),
      now: () => 5_000_000_000
    };
    return { deps: value, saved };
  }

  const moved: ApiOperationContract = {
    ...taught,
    operation_id: "op-moved",
    request: { ...taught.request, url: "https://shop.example/api/v2/search?q=laptops&page=1&lang=en" },
    verification: { status: "verified", checks: [] }
  };

  it("re-learns from the trigger page with the taught inputs, as a candidate that replaces the recipe", async () => {
    const { deps: d, saved } = deps({
      ok: true,
      data: {
        candidate_id: "SK",
        revision_id: "rev-2",
        recipe_id: "recipe-api-v2-moved",
        operation: moved,
        contract: moved,
        verification: moved.verification,
        warnings: [],
        promotion: ""
      }
    });
    const outcome = await repairApiOperation(d, { skill_id: "SK", recipe_id: "recipe-old", contract: taught });
    expect(d.learn).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "search",
        page_url: taught.trigger.url,
        examples: [{ q: "laptops" }, { q: "keyboards" }],
        verify_args: { q: "monitors" },
        id: "SK",
        source: "repair",
        parent_operation_id: taught.operation_id,
        replace_recipe_id: "recipe-old"
      })
    );
    expect(outcome).toMatchObject({
      ok: true,
      data: { proposed_revision_id: "rev-2", active_revision_unchanged: true, verification: "verified", changes: ["path /api/search → /api/v2/search"] }
    });
    expect(saved[0]["SK:search"].attempts).toEqual([{ at: 5_000_000_000, outcome: "repaired" }]);
  });

  it("refuses writes, missing inputs and a cooled-down operation, without learning", async () => {
    const { deps: d } = deps({ ok: false, error: { code: "X", message: "x" } });
    expect(await repairApiOperation(d, { skill_id: "SK", recipe_id: "r", contract: { ...taught, side_effect: "write" } })).toMatchObject({
      ok: false,
      error: { code: "API_REPAIR_WRITE" }
    });
    expect(await repairApiOperation(d, { skill_id: "SK", recipe_id: "r", contract: searchContract() })).toMatchObject({
      ok: false,
      error: { code: "API_REPAIR_INPUT" }
    });
    const cooled = deps({ ok: false, error: { code: "X", message: "x" } }, { "SK:search": { attempts: [{ at: 5_000_000_000 - 1000, outcome: "failed" }] } });
    expect(await repairApiOperation(cooled.deps, { skill_id: "SK", recipe_id: "r", contract: taught })).toMatchObject({
      ok: false,
      error: { code: "API_REPAIR_COOLDOWN" },
      data: { retry_after_minutes: 60 }
    });
    expect(d.learn).not.toHaveBeenCalled();
    expect(cooled.deps.learn).not.toHaveBeenCalled();
  });

  it("records a failed repair so the next one waits", async () => {
    const { deps: d, saved } = deps({ ok: false, error: { code: "API_LEARN_FAILED", message: "no request carries the example values" } });
    const outcome = await repairApiOperation(d, { skill_id: "SK", recipe_id: "r", contract: taught });
    expect(outcome).toMatchObject({ ok: false, error: { code: "API_LEARN_FAILED" } });
    expect(saved[0]["SK:search"].attempts[0].outcome).toBe("failed");
  });

  it("describes changes and next steps in plain words", () => {
    expect(contractDiff(taught, { ...taught, response: { ...taught.response, extract: "products" }, min_tier: 3 })).toEqual([
      "results read from products (was items)",
      "minimum tier 1 → 3"
    ]);
    expect(nextForClass("endpoint_drift", "https://shop.example")).toMatch(/site_skill repair/);
    expect(nextForClass("auth", "https://shop.example")).toMatch(/sign in to https:\/\/shop.example/);
    expect(nextForClass("ambiguous_write", "x")).toMatch(/do not run it again/);
    expect(nextForClass("ok", "x")).toBeUndefined();
  });
});
