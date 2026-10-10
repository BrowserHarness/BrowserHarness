import { describe, expect, it, vi } from "vitest";
import { fillPageUrl, learnApiOperation, type ApiLearnDeps } from "./api-learning";
import type { ApiCapture } from "./api-capture";
import { searchContract } from "../runtime/api-recipe.fixture";
import { withApiRecipe } from "../runtime/api-recipe";

function capture(url: string): ApiCapture {
  return {
    capture_version: 1,
    final_url: url,
    locations: [url],
    exchanges: [],
    cookies: [{ name: "sid", value: "secret-cookie-value", domain: "shop.example", path: "/", expires: -1, httpOnly: true, secure: true }],
    storage: { token: "secret-storage-value" }
  };
}

function deps(overrides: Partial<ApiLearnDeps> = {}) {
  const saved: unknown[] = [];
  const evaluations: unknown[] = [];
  const executions: unknown[] = [];
  const base: ApiLearnDeps = {
    runPage: vi.fn(async (url: string) => capture(url)),
    bridge: vi.fn(async (_action, payload) => ({
      ok: true,
      data: {
        contract: searchContract(),
        warnings: [],
        verification: searchContract().verification.checks.at(-1),
        verification_response: { ok: true, class: "ok", tier: 1, data: [{ id: "m1" }], item_count: 1, fetched_at: "", fresh: true },
        echo: payload
      }
    })),
    loadBase: vi.fn(async () => null),
    save: vi.fn(async (candidate, reason) => {
      saved.push({ candidate, reason });
      return { revision_id: "rev-1" };
    }),
    evaluate: vi.fn(async (_id, _revision, entry) => {
      evaluations.push(entry);
    }),
    execution: vi.fn(async (_id, _revision, entry) => {
      executions.push(entry);
      return entry;
    }),
    now: () => "2026-10-10T06:00:00.000Z",
    newId: () => "abc123",
    ...overrides
  };
  return { deps: base, saved, evaluations, executions };
}

const input = {
  name: "search",
  page_url: "https://shop.example/search?q={q}",
  examples: [{ q: "laptops" }, { q: "lap tops & more" }],
  verify_args: { q: "monitors" }
};

describe("site_skill learn_api", () => {
  it("fills {name} holes percent-encoded", () => {
    expect(fillPageUrl(input.page_url, { q: "lap tops & more" })).toBe("https://shop.example/search?q=lap%20tops%20%26%20more");
  });

  it("runs the page once per example, learns through the Bridge and saves an unpromoted candidate with its evidence", async () => {
    const { deps: d, saved, evaluations, executions } = deps();
    const outcome = await learnApiOperation(d, input);
    expect(outcome.ok).toBe(true);
    expect(d.runPage).toHaveBeenNthCalledWith(1, "https://shop.example/search?q=laptops");
    expect(d.runPage).toHaveBeenNthCalledWith(2, "https://shop.example/search?q=lap%20tops%20%26%20more");
    const payload = vi.mocked(d.bridge).mock.calls[0][1];
    expect(payload).toMatchObject({ name: "search", examples: input.examples, verify_args: { q: "monitors" }, trigger: { url: input.page_url }, evidence_ids: ["api-abc123"] });

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ reason: "create", candidate: { status: "candidate", lifecycle: { auto_promote: false } } });
    expect(JSON.stringify(saved)).not.toMatch(/secret-cookie-value|secret-storage-value/);
    expect(evaluations).toEqual([
      expect.objectContaining({ kind: "structural-verification", outcome: "passed" }),
      expect.objectContaining({ kind: "execution", outcome: "passed" })
    ]);
    expect(executions).toEqual([expect.objectContaining({ outcome: "passed", parameter_names: ["q"], submitted: false })]);
    if (outcome.ok) {
      expect(outcome.data.operation).toMatchObject({ name: "search", side_effect: "read" });
      expect(outcome.data.result_preview).toEqual([{ id: "m1" }]);
      expect(outcome.data.promotion).toMatch(/Promote it with site_skill promote/);
    }
  });

  it("adds to an existing Skill as a refinement revision", async () => {
    const existing = withApiRecipe(null, {
      contract: { ...searchContract(), operation_id: "op-other", name: "other" },
      entry_url: "https://shop.example/",
      title: "Shop",
      evidence_id: "old",
      captured_at: ""
    });
    const { deps: d, saved } = deps({ loadBase: vi.fn(async () => ({ candidate: existing, revision_id: "rev-0" })) });
    const outcome = await learnApiOperation(d, { ...input, id: existing.id });
    expect(outcome.ok).toBe(true);
    expect(saved[0]).toMatchObject({ reason: "refinement", candidate: { id: existing.id } });
    expect((saved[0] as { candidate: { recipes: unknown[] } }).candidate.recipes).toHaveLength(2);
  });

  it("records a failed verification as failed evidence and says it will not be promoted", async () => {
    const failedCheck = { kind: "unseen_input", passed: false, tier: 1, class: "ok", arg_names: ["q"], detail: "found nothing", checked_at: "" };
    const { deps: d, evaluations } = deps({
      bridge: vi.fn(async () => ({
        ok: true,
        data: { contract: { ...searchContract(), verification: { status: "failed", checks: [failedCheck] } }, verification: failedCheck }
      }))
    });
    const outcome = await learnApiOperation(d, input);
    expect(outcome.ok).toBe(true);
    expect(evaluations).toEqual([
      expect.objectContaining({ kind: "structural-verification", outcome: "failed" }),
      expect.objectContaining({ kind: "execution", outcome: "failed" })
    ]);
    if (outcome.ok) expect(outcome.data.promotion).toMatch(/will not be promoted/);
  });

  it("refuses writes, bad input and a missing third input before opening any page", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...input, side_effect: "write" }, "API_LEARN_WRITE_REFUSED"],
      [{ ...input, name: "two words" }, "API_LEARN_INPUT"],
      [{ ...input, page_url: "https://shop.example/search" }, "API_LEARN_INPUT"],
      [{ ...input, page_url: "file:///etc/{q}" }, "API_LEARN_INPUT"],
      [{ ...input, examples: [{ q: "laptops" }] }, "API_LEARN_INPUT"],
      [{ ...input, verify_args: undefined }, "API_LEARN_INPUT"]
    ];
    for (const [bad, code] of cases) {
      const { deps: d } = deps();
      const outcome = await learnApiOperation(d, bad as never);
      expect(outcome.ok, JSON.stringify(bad)).toBe(false);
      if (!outcome.ok) expect(outcome.error.code).toBe(code);
      expect(d.runPage).not.toHaveBeenCalled();
    }
  });

  it("passes Bridge errors through and saves nothing", async () => {
    const { deps: d, saved } = deps({
      bridge: vi.fn(async () => ({ ok: false, error: { code: "API_LEARN_FAILED", message: "no request carries the example values", details: "[]" } }))
    });
    const outcome = await learnApiOperation(d, input);
    expect(outcome).toMatchObject({ ok: false, error: { code: "API_LEARN_FAILED" } });
    expect(saved).toHaveLength(0);
  });
});
