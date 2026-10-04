import { describe, expect, it } from "vitest";
import {
  compileSiteEvidenceToCandidate,
  createSiteSkillEvidence,
  summarizeSiteNetworkEvidence,
  type SiteFormEvidence
} from "./site-skill";

const forms: SiteFormEvidence[] = [
  {
    index: 0,
    id: "checkout",
    action: "https://shop.example/checkout",
    method: "POST",
    fields: [
      {
        tag: "input",
        type: "email",
        name: "email",
        id: "email",
        accessible_name: "Email",
        required: true
      },
      {
        tag: "input",
        type: "password",
        name: "password",
        id: "password",
        accessible_name: "Password",
        required: true
      },
      {
        tag: "select",
        type: "select-one",
        name: "country",
        id: "country",
        accessible_name: "Country",
        required: true,
        options: ["IN", "US"]
      }
    ],
    submit: {
      accessible_name: "Continue",
      id: "continue"
    }
  }
];

function ax() {
  return {
    text: "",
    elements: [
      {
        element_id: "@e1",
        backend_node_id: 1,
        role: "textbox",
        name: "Email",
        disabled: false,
        focused: false
      },
      {
        element_id: "@e2",
        backend_node_id: 2,
        role: "button",
        name: "Continue",
        disabled: false,
        focused: false
      }
    ]
  };
}

describe("Site -> Skill v1", () => {
  it("creates bounded site evidence without retaining request secret values", () => {
    const evidence = createSiteSkillEvidence({
      evidence_id: "ev-1",
      captured_at: "2026-09-28T02:00:00.000Z",
      url: "https://shop.example/checkout",
      title: "Checkout",
      ax: ax(),
      forms,
      network_records: [
        {
          request_id: "r1",
          url: "https://shop.example/api/checkout",
          method: "POST",
          request_headers: {
            authorization: "Bearer secret",
            "x-csrf-token": "secret-token"
          },
          post_data:
            '{"email":"user@example.com","password":"secret"}',
          status: 200,
          mime_type: "application/json",
          started_at: 1
        }
      ]
    });

    expect(evidence.network[0]).toEqual({
      request_id: "r1",
      method: "POST",
      url: "https://shop.example/api/checkout",
      status: 200,
      mime_type: "application/json",
      header_names: ["authorization", "x-csrf-token"],
      post_data_keys: ["email", "password"]
    });
    expect(JSON.stringify(evidence)).not.toContain("Bearer secret");
    expect(JSON.stringify(evidence)).not.toContain("user@example.com");
  });

  it("compiles forms into candidate-only parameterized recipes", () => {
    const evidence = createSiteSkillEvidence({
      evidence_id: "ev-2",
      captured_at: "2026-09-28T02:00:00.000Z",
      url: "https://shop.example/checkout",
      title: "Checkout",
      ax: ax(),
      forms
    });

    const skill = compileSiteEvidenceToCandidate(
      evidence,
      "Shop checkout"
    );

    expect(skill).toMatchObject({
      id: "SK-SITE-EV-2",
      slug: "shop-checkout",
      name: "Shop checkout",
      status: "candidate",
      lifecycle: {
        auto_promote: false,
        promotion_requires_evaluation: true
      },
      safety: {
        execution_requires_fresh_resolution: true,
        approval_policy: "preserve_browserharness_approval_rules",
        structural_analysis_is_not_execution_proof: true
      }
    });

    expect(skill.parameters).toEqual([
      expect.objectContaining({
        name: "email",
        type: "string",
        required: true,
        sensitive: false
      }),
      expect.objectContaining({
        name: "password",
        type: "string",
        sensitive: true
      }),
      expect.objectContaining({
        name: "country",
        options: ["IN", "US"]
      })
    ]);

    expect(skill.recipes[0].steps).toEqual([
      expect.objectContaining({
        kind: "input",
        input_mode: "type",
        parameter: "email"
      }),
      expect.objectContaining({
        kind: "input",
        input_mode: "type",
        parameter: "password"
      }),
      expect.objectContaining({
        kind: "input",
        input_mode: "select",
        parameter: "country"
      }),
      expect.objectContaining({
        kind: "submit",
        approval: "browserharness_runtime",
        method: "POST"
      })
    ]);
  });

  it("requires actionable form evidence before creating a Site Skill", () => {
    const evidence = createSiteSkillEvidence({
      evidence_id: "ev-empty",
      captured_at: "2026-09-28T02:00:00.000Z",
      url: "https://example.com/",
      title: "Example",
      ax: ax(),
      forms: []
    });

    expect(() =>
      compileSiteEvidenceToCandidate(evidence)
    ).toThrow("ACTIONABLE_FORM_EVIDENCE");
  });

  it("summarizes URL-encoded POST keys without retaining values", () => {
    const summary = summarizeSiteNetworkEvidence([
      {
        request_id: "r2",
        url: "https://example.com/search",
        method: "POST",
        request_headers: {
          cookie: "secret"
        },
        post_data: "query=browserharness&page=2",
        started_at: 1
      }
    ]);

    expect(summary[0].post_data_keys).toEqual(["page", "query"]);
    expect(JSON.stringify(summary)).not.toContain("browserharness");
    expect(JSON.stringify(summary)).not.toContain("secret");
  });
});
