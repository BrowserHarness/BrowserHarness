import { describe, expect, it } from "vitest";
import {
  buildSiteCommands,
  findSiteCommand,
  parseCommandArgs,
  recipeLabel,
  recipeParameters,
  siteLabel,
  usage
} from "./site-commands";
import type { SiteCandidateSkill, SiteSkillRecipe } from "./site-skill";
import type { SiteSkillFamilyRecord } from "./site-skill-store";

function apiRecipe(index: number, path: string, parameters: string[], defaults: Record<string, string> = {}): SiteSkillRecipe {
  return {
    id: `recipe-api-${index}`,
    name: `GET ${path}`,
    entry_url: "https://www.shop.example.com/",
    form_index: -1,
    method: "GET",
    action: path,
    parameters,
    steps: [
      {
        kind: "api_fetch",
        method: "GET",
        path,
        query: parameters.map((parameter) => ({
          key: parameter.replace(/^api\d+_/, ""),
          parameter,
          ...(defaults[parameter] ? { default: defaults[parameter] } : {})
        })),
        response: { format: "json", max_chars: 20000 },
        approval: "none_read_only"
      }
    ],
    verification: { required: true, checks: [] }
  };
}

const formRecipe: SiteSkillRecipe = {
  id: "recipe-form-1",
  name: "Search",
  entry_url: "https://www.shop.example.com/",
  form_index: 0,
  method: "GET",
  action: "/search",
  parameters: ["q"],
  steps: [],
  verification: { required: true, checks: [] }
};

function candidate(recipes: SiteSkillRecipe[]): SiteCandidateSkill {
  return {
    schema_version: 1,
    id: "SK-SITE-1",
    slug: "shop",
    name: "Shop",
    version: "0.1.0",
    status: "candidate",
    lifecycle: { auto_promote: false, promotion_requires_evaluation: true },
    site: { origin: "https://www.shop.example.com", entry_url: "https://www.shop.example.com/", title: "Shop" },
    parameters: [
      { name: "q", label: "Search", type: "string", required: true, sensitive: false, source: { form_index: 0, field_name: "q" } },
      { name: "api1_q", label: "q", type: "string", required: true, sensitive: false, source: { form_index: -1, field_name: "q" } },
      { name: "api1_page", label: "page", type: "string", required: false, sensitive: false, source: { form_index: -1, field_name: "page" } },
      { name: "api2_limit", label: "limit", type: "string", required: false, sensitive: false, source: { form_index: -1, field_name: "limit" } }
    ],
    recipes,
    network_candidates: [],
    safety: {
      execution_requires_fresh_resolution: true,
      approval_policy: "preserve_browserharness_approval_rules",
      structural_analysis_is_not_execution_proof: true
    },
    provenance: {
      source_kind: "site_analysis_v1",
      evidence_id: "ev-1",
      captured_at: "2026-10-05T00:00:00.000Z",
      ax_target_count: 1,
      form_count: 1,
      network_request_count: 2
    }
  };
}

function family(overrides: Partial<SiteSkillFamilyRecord> = {}): SiteSkillFamilyRecord {
  return {
    id: "SK-SITE-1",
    slug: "shop",
    name: "Shop",
    latest_revision_id: "rev-1",
    revisions: [
      {
        revision_id: "rev-1",
        ordinal: 1,
        created_at: "2026-10-05T00:00:00.000Z",
        reason: "create",
        candidate: candidate([
          formRecipe,
          apiRecipe(1, "/api/v2/products/search", ["api1_q", "api1_page"], { api1_page: "1" }),
          apiRecipe(2, "/api/deals.json", ["api2_limit"])
        ])
      }
    ],
    evaluations: [],
    executions: [
      {
        execution_id: "x1",
        revision_id: "rev-1",
        recipe_id: "recipe-api-1",
        started_at: "",
        finished_at: "",
        outcome: "passed",
        executed_steps: 1,
        submitted: false,
        parameter_names: ["api1_q"]
      }
    ],
    lifecycle_events: [],
    ...overrides
  };
}

describe("site commands", () => {
  it("names sites and recipes the way people say them", () => {
    expect(siteLabel("https://www.amazon.co.uk")).toBe("amazon");
    expect(siteLabel("https://shop.example.com")).toBe("shop-example");
    expect(siteLabel("http://127.0.0.1:4173")).toBe("local");
    expect(siteLabel("https://github.com")).toBe("github");
    expect(recipeLabel(apiRecipe(1, "/api/v2/products/search", []))).toBe("products-search");
    expect(recipeLabel(apiRecipe(1, "/api/deals.json", []))).toBe("deals");
    expect(recipeLabel(formRecipe)).toBe("search");
    expect(recipeLabel({ ...formRecipe, name: "Form 2" })).toBe("form");
  });

  it("turns every recipe into a named command with friendly parameters", () => {
    const commands = buildSiteCommands([family()]);
    expect(commands.map((command) => command.name)).toEqual([
      "shop-example-search",
      "shop-example-products-search",
      "shop-example-deals"
    ]);
    const search = commands[1];
    expect(search.kind).toBe("read");
    expect(search.status).toBe("testing");
    expect(search.runs).toBe(1);
    expect(search.worked).toBe(1);
    expect(search.parameters.map((parameter) => [parameter.name, parameter.key, parameter.required, parameter.default])).toEqual([
      ["q", "api1_q", true, undefined],
      ["page", "api1_page", false, "1"]
    ]);
    expect(commands[0].kind).toBe("form");
    expect(usage(search)).toBe("shop-example-products-search q=… [page=…]");
  });

  it("marks proven and failed Skills, honours renames and avoids clashes", () => {
    const proven = buildSiteCommands([family({ active_revision_id: "rev-1" })]);
    expect(proven[0].status).toBe("proven");
    const failed = buildSiteCommands([
      family({
        evaluations: [
          { evaluation_id: "e", revision_id: "rev-1", recorded_at: "", kind: "structural-verification", outcome: "failed" }
        ]
      })
    ]);
    expect(failed[0].status).toBe("check failed");

    const renamed = buildSiteCommands([family()], { "SK-SITE-1:recipe-api-2": "Shop Deals!" }, ["help"]);
    expect(renamed.map((command) => command.name)).toContain("shop-deals");

    const clash = buildSiteCommands([family()], { "SK-SITE-1:recipe-api-2": "shop-example-search" });
    expect(clash.map((command) => command.name)).toEqual([
      "shop-example-search-2",
      "shop-example-products-search",
      "shop-example-search"
    ]);
    expect(buildSiteCommands([family()], {}, ["shop-example-search"])[0].name).toBe("shop-example-search-2");
  });

  it("reads plain, named and flag arguments", () => {
    const search = findSiteCommand(buildSiteCommands([family()]), "/Shop-Example-Products-Search") as NonNullable<
      ReturnType<typeof findSiteCommand>
    >;
    expect(search).not.toBeNull();
    expect(parseCommandArgs(search, "electric kettle")).toEqual({ q: "electric kettle" });
    expect(parseCommandArgs(search, "q=kettle page=2")).toEqual({ q: "kettle", page: "2" });
    expect(parseCommandArgs(search, '--q "steel kettle" --page 3')).toEqual({ q: "steel kettle", page: "3" });
    expect(parseCommandArgs(search, "")).toEqual({});
  });

  it("maps values to the recipe's own names and explains mistakes", () => {
    const search = buildSiteCommands([family()])[1];
    expect(recipeParameters(search, { q: "kettle" })).toEqual({ ok: true, parameters: { api1_q: "kettle" } });
    expect(recipeParameters(search, { api1_q: "kettle", page: "2" })).toEqual({
      ok: true,
      parameters: { api1_q: "kettle", api1_page: "2" }
    });
    const missing = recipeParameters(search, {});
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.error).toContain("needs q");
    const wrong = recipeParameters(search, { colour: "red" });
    expect(!wrong.ok && wrong.error).toContain("has no colour");
  });
});
