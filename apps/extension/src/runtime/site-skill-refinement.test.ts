import { describe, expect, it } from "vitest";
import {
  compareSiteSkillContracts,
  createRefinedSiteSkillCandidate
} from "./site-skill-refinement";
import type { SiteCandidateSkill } from "./site-skill";

function candidate(): SiteCandidateSkill {
  return {
    schema_version: 1,
    id: "SK-SITE-1",
    slug: "checkout",
    name: "Checkout",
    version: "0.1.0",
    status: "candidate",
    lifecycle: {
      auto_promote: false,
      promotion_requires_evaluation: true
    },
    site: {
      origin: "https://shop.example",
      entry_url: "https://shop.example/checkout",
      title: "Checkout"
    },
    parameters: [
      {
        name: "email",
        label: "Email",
        type: "string",
        required: true,
        sensitive: false,
        source: {
          form_index: 0,
          field_name: "email"
        }
      }
    ],
    recipes: [
      {
        id: "recipe-form-1",
        name: "Checkout",
        entry_url: "https://shop.example/checkout",
        form_index: 0,
        method: "POST",
        action: "https://shop.example/submit",
        parameters: ["email"],
        steps: [
          {
            kind: "input",
            form_index: 0,
            input_mode: "type",
            parameter: "email",
            target: {
              role: "textbox",
              accessible_name: "Email",
              tag: "input",
              input_type: "email",
              selector_hints: {
                name: "email"
              },
              resolution: "fresh_semantic_then_dom_hint"
            }
          },
          {
            kind: "submit",
            form_index: 0,
            method: "POST",
            action: "https://shop.example/submit",
            approval: "browsercrew_runtime"
          }
        ],
        verification: {
          required: true,
          checks: [
            {
              kind: "form_present",
              expect: {
                action: "https://shop.example/submit",
                method: "POST"
              }
            }
          ]
        }
      }
    ],
    network_candidates: [],
    safety: {
      execution_requires_fresh_resolution: true,
      approval_policy: "preserve_browsercrew_approval_rules",
      structural_analysis_is_not_execution_proof: true
    },
    provenance: {
      source_kind: "site_analysis_v1",
      evidence_id: "evidence-1",
      captured_at: "2026-09-28T03:00:00.000Z",
      ax_target_count: 2,
      form_count: 1,
      network_request_count: 0
    }
  };
}

describe("Site Skill refinement", () => {
  it("detects no contract change when only evidence provenance changed", () => {
    const previous = candidate();
    const fresh = candidate();
    fresh.id = "SK-SITE-NEW";
    fresh.provenance.evidence_id = "evidence-2";
    fresh.provenance.captured_at = "2026-09-28T04:00:00.000Z";

    expect(compareSiteSkillContracts(previous, fresh)).toEqual({
      changed: false,
      parameters: {
        added: [],
        removed: [],
        changed: []
      },
      recipes: {
        added: [],
        removed: [],
        changed: []
      }
    });
  });

  it("reports field and recipe contract drift", () => {
    const previous = candidate();
    const fresh = candidate();
    fresh.parameters[0].required = false;
    fresh.parameters.push({
      name: "phone",
      label: "Phone",
      type: "string",
      required: true,
      sensitive: false,
      source: {
        form_index: 0,
        field_name: "phone"
      }
    });
    fresh.recipes[0].parameters.push("phone");

    const diff = compareSiteSkillContracts(previous, fresh);

    expect(diff.changed).toBe(true);
    expect(diff.parameters.added).toEqual(["phone"]);
    expect(diff.parameters.changed).toEqual(["email"]);
    expect(diff.recipes.changed).toEqual(["recipe-form-1"]);
  });

  it("preserves Skill family identity and candidate-only lifecycle", () => {
    const previous = candidate();
    const fresh = candidate();
    fresh.id = "SK-SITE-FRESH";
    fresh.slug = "fresh";
    fresh.name = "Fresh";
    fresh.parameters[0].required = false;

    const refined = createRefinedSiteSkillCandidate(
      previous,
      fresh
    );

    expect(refined.diff.changed).toBe(true);
    expect(refined.candidate).toMatchObject({
      id: previous.id,
      slug: previous.slug,
      name: previous.name,
      status: "candidate",
      lifecycle: {
        auto_promote: false,
        promotion_requires_evaluation: true
      }
    });
  });

  it("rejects refinement evidence from another origin", () => {
    const previous = candidate();
    const fresh = candidate();
    fresh.site.origin = "https://evil.example";

    expect(() =>
      createRefinedSiteSkillCandidate(previous, fresh)
    ).toThrow("ORIGIN_MISMATCH");
  });
});
