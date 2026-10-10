import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureAxSnapshot: vi.fn(),
  trustedClick: vi.fn(),
  trustedKey: vi.fn(),
  trustedType: vi.fn(),
  selectOptions: vi.fn(),
  uploadFiles: vi.fn(),
  evaluatePageExpression: vi.fn()
}));

vi.mock("../background/cdp-semantic", () => ({ captureAxSnapshot: mocks.captureAxSnapshot }));
vi.mock("../background/cdp-input", () => ({
  trustedClick: mocks.trustedClick,
  trustedKey: mocks.trustedKey,
  trustedType: mocks.trustedType
}));
vi.mock("../background/cdp-select", () => ({ selectOptions: mocks.selectOptions }));
vi.mock("../background/page-evaluate", () => ({ evaluatePageExpression: mocks.evaluatePageExpression }));
vi.mock("../background/file-tools", () => ({ uploadFiles: mocks.uploadFiles }));

import {
  apiRecipeFromContract,
  apiRecipeNeedsApproval,
  contractArgs,
  isApiContract,
  recipeKind,
  withApiRecipe,
  type ApiCallResult
} from "./api-recipe";
import { searchContract } from "./api-recipe.fixture";
import { runSiteSkillRecipe, SiteSkillRunError } from "./site-skill-runner";
import { buildSiteCommands } from "./site-commands";

const learning = {
  entry_url: "https://shop.example/search",
  title: "shop.example",
  evidence_id: "api-abc123",
  captured_at: "2026-10-10T06:00:00.000Z"
};

function okResult(data: unknown): ApiCallResult {
  return { ok: true, class: "ok", tier: 1, status: 200, ms: 12, data, item_count: Array.isArray(data) ? data.length : 1, fetched_at: "2026-10-10T06:00:01.000Z", fresh: true };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("API Recipe v2", () => {
  it("wraps a contract as an api recipe with one api_operation step", () => {
    const contract = searchContract();
    expect(isApiContract(contract)).toBe(true);
    expect(isApiContract({ ...contract, contract_version: 1 })).toBe(false);
    const recipe = apiRecipeFromContract(contract, learning.entry_url);
    expect(recipe).toMatchObject({
      id: "recipe-api-v2-e7562f40fbcdce1c",
      kind: "api",
      form_index: -1,
      method: "GET",
      action: "/api/search",
      parameters: ["q"]
    });
    expect(recipe.steps).toEqual([{ kind: "api_operation", contract, approval: "none_read_only" }]);
    expect(recipeKind(recipe)).toBe("api");
    expect(apiRecipeNeedsApproval(recipe)).toBe(false);
  });

  it("asks for approval for anything not known to be a read", () => {
    for (const side_effect of ["write", "unknown"] as const) {
      const recipe = apiRecipeFromContract({ ...searchContract(), side_effect }, learning.entry_url);
      expect(apiRecipeNeedsApproval(recipe)).toBe(true);
      expect(recipe.steps[0]).toMatchObject({ approval: "browserharness_runtime" });
    }
  });

  it("creates a new Skill or adds the operation to an existing one, replacing an earlier copy", () => {
    const created = withApiRecipe(null, { ...learning, contract: searchContract() });
    expect(created).toMatchObject({
      id: "SK-SITE-API-ABC123",
      status: "candidate",
      lifecycle: { auto_promote: false, promotion_requires_evaluation: true },
      site: { origin: "https://shop.example" },
      provenance: { source_kind: "api_learning_v2" }
    });
    expect(created.parameters).toEqual([
      { name: "q", label: "q", type: "string", required: true, sensitive: false, source: { form_index: -1, field_name: "q" } }
    ]);

    const again = withApiRecipe(created, { ...learning, contract: { ...searchContract(), description: "Search again" } });
    expect(again.id).toBe(created.id);
    expect(again.recipes).toHaveLength(1);
    expect(again.recipes[0].name).toBe("Search again");

    expect(() => withApiRecipe(created, { ...learning, contract: { ...searchContract(), origin: "https://other.example" } })).toThrow(
      /SITE_SKILL_ORIGIN_MISMATCH/
    );
  });

  it("keeps no example values or session values in the stored recipe beyond the contract's own params", () => {
    const text = JSON.stringify(withApiRecipe(null, { ...learning, contract: searchContract() }));
    expect(text).not.toMatch(/cookie"\s*:/i);
    expect(text).not.toMatch(/authorization/i);
  });

  it("maps recipe parameter values to the contract's own param names", () => {
    expect(contractArgs(searchContract(), { q: "monitors", other: 1 })).toEqual({ q: "monitors" });
  });

  it("runs an api_operation step through the injected transport and returns the fresh answer", async () => {
    const candidate = withApiRecipe(null, { ...learning, contract: searchContract() });
    const apiCall = vi.fn(async () => okResult([{ id: "m1", title: "27 inch monitor" }]));
    const run = await runSiteSkillRecipe({ tab_id: 1, candidate, recipe_id: candidate.recipes[0].id, parameters: { q: "monitors" }, api_call: apiCall });
    expect(apiCall).toHaveBeenCalledWith(searchContract(), { q: "monitors" });
    expect(run).toMatchObject({
      executed_steps: 1,
      submitted: false,
      output: { http_status: 200, data: [{ id: "m1", title: "27 inch monitor" }], api: { tier: 1, class: "ok", item_count: 1 } }
    });
    expect(mocks.evaluatePageExpression).not.toHaveBeenCalled();
  });

  it("reports failures by class, and a write that left the browser as submitted", async () => {
    const write = { ...searchContract(), side_effect: "write" as const };
    const candidate = withApiRecipe(null, { ...learning, contract: write });
    const ambiguous = vi.fn(async () => ({ ...okResult(null), ok: false, class: "ambiguous_write" as const, data: undefined, reason: "no answer", next: "do not resend" }));
    const error = await runSiteSkillRecipe({ tab_id: 1, candidate, recipe_id: candidate.recipes[0].id, parameters: { q: "x1" }, api_call: ambiguous }).catch((caught) => caught);
    expect(error).toBeInstanceOf(SiteSkillRunError);
    expect(error.code).toBe("API_AMBIGUOUS_WRITE");
    expect(error.submitted).toBe(true);
    expect(ambiguous).toHaveBeenCalledTimes(1);

    const missing = await runSiteSkillRecipe({ tab_id: 1, candidate, recipe_id: candidate.recipes[0].id, parameters: { q: "x1" } }).catch((caught) => caught);
    expect(missing.code).toBe("API_ENGINE_UNAVAILABLE");
  });

  it("lists a learned read as a read command and a learned write as a form-like command", () => {
    const read = withApiRecipe(null, { ...learning, contract: searchContract() });
    const family = (candidate: typeof read) => ({
      id: candidate.id,
      slug: candidate.slug,
      name: candidate.name,
      latest_revision_id: "r1",
      revisions: [{ revision_id: "r1", ordinal: 1, created_at: "", reason: "create" as const, candidate }],
      evaluations: [],
      executions: [],
      lifecycle_events: []
    });
    const [command] = buildSiteCommands([family(read)]);
    expect(command).toMatchObject({ kind: "read", parameters: [{ name: "q", key: "q", required: true }] });
    const write = withApiRecipe(null, { ...learning, contract: { ...searchContract(), side_effect: "write" } });
    expect(buildSiteCommands([family(write)])[0].kind).toBe("form");
  });
});
