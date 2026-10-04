import { describe, expect, it } from "vitest";
import {
  apiFetchExpression,
  buildApiFetchUrl,
  deriveApiRecipes,
  type ApiFetchStep
} from "./site-skill-api";
import {
  compileSiteEvidenceToCandidate,
  type SiteSkillEvidence
} from "./site-skill";

function evidence(
  network: SiteSkillEvidence["network"]
): SiteSkillEvidence {
  return {
    schema_version: 1,
    evidence_id: "ev-1",
    captured_at: "2026-10-04T00:00:00Z",
    site: {
      url: "https://shop.example.com/",
      origin: "https://shop.example.com",
      title: "Shop"
    },
    ax: { target_count: 0, targets: [] },
    forms: [],
    network
  };
}

const rec = (over: Partial<SiteSkillEvidence["network"][number]>) => ({
  request_id: "r",
  method: "GET",
  url: "https://shop.example.com/api/search?q=shoes&page=1&token=abc",
  status: 200,
  mime_type: "application/json",
  header_names: [],
  post_data_keys: [],
  ...over
});

describe("api recipe derivation", () => {
  it("turns same-origin JSON GETs into read-only recipes and never stores sensitive values", () => {
    const { recipes, parameters } = deriveApiRecipes(
      evidence([
        rec({}),
        rec({ request_id: "x", url: "https://cdn.other.com/api/y?z=1" }),
        rec({ request_id: "p", method: "POST" }),
        rec({ request_id: "a", url: "https://shop.example.com/analytics/collect?x=1" }),
        rec({ request_id: "h", mime_type: "text/html", url: "https://shop.example.com/page" }),
        rec({ request_id: "e", status: 500, url: "https://shop.example.com/api/broken" })
      ])
    );
    expect(recipes).toHaveLength(1);
    const step = recipes[0].steps[0] as ApiFetchStep;
    expect(step.query).toEqual([
      { key: "q", parameter: "api1_q", default: "shoes" },
      { key: "page", parameter: "api1_page", default: "1" },
      { key: "token", parameter: "api1_token" }
    ]);
    expect(parameters.find((p) => p.label === "token")).toMatchObject({
      sensitive: true,
      required: true
    });
    expect(JSON.stringify(recipes)).not.toContain("abc");
  });

  it("makes a candidate from API evidence alone", () => {
    const candidate = compileSiteEvidenceToCandidate(evidence([rec({})]));
    expect(candidate.recipes[0].id).toBe("recipe-api-1");
    expect(candidate.parameters.map((p) => p.name)).toContain("api1_q");
    expect(() =>
      compileSiteEvidenceToCandidate(evidence([]))
    ).toThrow("SITE_SKILL_REQUIRES_ACTIONABLE_FORM_EVIDENCE");
  });
});

describe("buildApiFetchUrl", () => {
  const step: ApiFetchStep = {
    kind: "api_fetch",
    method: "GET",
    path: "/api/search",
    query: [
      { key: "q", parameter: "q", default: "a" },
      { key: "t", parameter: "t" }
    ],
    response: { format: "json", max_chars: 100 },
    approval: "none_read_only"
  };

  it("applies values over defaults and requires parameters without defaults", () => {
    expect(
      buildApiFetchUrl("https://shop.example.com", step, { q: "b", t: "x" })
    ).toBe("https://shop.example.com/api/search?q=b&t=x");
    expect(() =>
      buildApiFetchUrl("https://shop.example.com", step, {})
    ).toThrow("SITE_SKILL_PARAMETER_REQUIRED: t");
  });

  it("rejects origin escapes", () => {
    for (const path of ["//evil.com/x", "https://evil.com/x", "api"]) {
      expect(() =>
        buildApiFetchUrl("https://shop.example.com", { ...step, path }, { t: "1" })
      ).toThrow();
    }
  });

  it("embeds the url as a JSON string literal", () => {
    const expression = apiFetchExpression('https://a.com/x?q="</script>', 10);
    expect(expression).toContain('"https://a.com/x?q=\\"</script>"');
  });
});
