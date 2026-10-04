import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SiteCandidateSkill } from "./site-skill";

const mocks = vi.hoisted(() => ({
  captureAxSnapshot: vi.fn(),
  trustedClick: vi.fn(),
  trustedKey: vi.fn(),
  trustedType: vi.fn(),
  selectOptions: vi.fn(),
  uploadFiles: vi.fn(),
  evaluatePageExpression: vi.fn()
}));

vi.mock("../background/cdp-semantic", () => ({
  captureAxSnapshot: mocks.captureAxSnapshot
}));
vi.mock("../background/cdp-input", () => ({
  trustedClick: mocks.trustedClick,
  trustedKey: mocks.trustedKey,
  trustedType: mocks.trustedType
}));
vi.mock("../background/cdp-select", () => ({
  selectOptions: mocks.selectOptions
}));
vi.mock("../background/page-evaluate", () => ({
  evaluatePageExpression: mocks.evaluatePageExpression
}));
vi.mock("../background/file-tools", () => ({
  uploadFiles: mocks.uploadFiles
}));

import {
  resolveSiteSkillTarget,
  runSiteSkillRecipe,
  SiteSkillRunError
} from "./site-skill-runner";

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
      origin: "https://example.com",
      entry_url: "https://example.com/checkout",
      title: "Checkout"
    },
    parameters: [
      {
        name: "email",
        label: "Email",
        type: "string",
        required: true,
        sensitive: false,
        source: { form_index: 0, field_name: "email" }
      },
      {
        name: "country",
        label: "Country",
        type: "string",
        required: true,
        sensitive: false,
        source: { form_index: 0, field_name: "country" },
        options: ["IN", "US"]
      }
    ],
    recipes: [
      {
        id: "recipe-form-1",
        name: "Checkout",
        entry_url: "https://example.com/checkout",
        form_index: 0,
        method: "POST",
        action: "https://example.com/checkout",
        parameters: ["email", "country"],
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
              selector_hints: { name: "email" },
              resolution: "fresh_semantic_then_dom_hint"
            }
          },
          {
            kind: "input",
            form_index: 0,
            input_mode: "select",
            parameter: "country",
            target: {
              role: "combobox",
              accessible_name: "Country",
              tag: "select",
              input_type: "select-one",
              selector_hints: { name: "country" },
              resolution: "fresh_semantic_then_dom_hint"
            }
          },
          {
            kind: "submit",
            form_index: 0,
            target: {
              role: "button",
              accessible_name: "Continue",
              tag: "button",
              selector_hints: { id: "continue" },
              resolution: "fresh_semantic_then_dom_hint"
            },
            method: "POST",
            action: "https://example.com/checkout",
            approval: "browsercrew_runtime"
          }
        ],
        verification: {
          required: true,
          checks: []
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
      evidence_id: "ev-1",
      captured_at: "2026-09-28T03:00:00.000Z",
      ax_target_count: 3,
      form_count: 1,
      network_request_count: 0
    }
  };
}

describe("Site Skill recipe runner", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.captureAxSnapshot
      .mockResolvedValueOnce({
        text: "",
        elements: [
          {
            element_id: "@e1",
            backend_node_id: 1,
            role: "textbox",
            name: "Email",
            disabled: false,
            focused: false
          }
        ]
      })
      .mockResolvedValueOnce({
        text: "",
        elements: [
          {
            element_id: "@e2",
            backend_node_id: 2,
            role: "combobox",
            name: "Country",
            disabled: false,
            focused: false
          }
        ]
      })
      .mockResolvedValueOnce({
        text: "",
        elements: [
          {
            element_id: "@e3",
            backend_node_id: 3,
            role: "button",
            name: "Continue",
            disabled: false,
            focused: false
          }
        ]
      });
    mocks.trustedType.mockResolvedValue({ typed: 16 });
    mocks.selectOptions.mockResolvedValue({ selected: ["IN"] });
    mocks.trustedClick.mockResolvedValue({ x: 10, y: 10 });
  });

  it("executes a verified recipe with fresh semantic refs", async () => {
    const result = await runSiteSkillRecipe({
      tab_id: 7,
      candidate: candidate(),
      parameters: {
        email: "user@example.com",
        country: "IN"
      }
    });

    expect(result).toEqual({
      recipe_id: "recipe-form-1",
      executed_steps: 3,
      submitted: true
    });
    expect(mocks.trustedType).toHaveBeenCalledWith(
      7,
      "@e1",
      "user@example.com"
    );
    expect(mocks.selectOptions).toHaveBeenCalledWith(
      7,
      "@e2",
      ["IN"]
    );
    expect(mocks.trustedClick).toHaveBeenCalledWith(7, "@e3");
  });

  it("preserves partial execution evidence when a later step fails", async () => {
    mocks.selectOptions.mockRejectedValueOnce(
      new Error("SELECT_OPTION_FAILED: option disappeared")
    );

    let caught: unknown;
    try {
      await runSiteSkillRecipe({
        tab_id: 7,
        candidate: candidate(),
        parameters: {
          email: "user@example.com",
          country: "IN"
        }
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SiteSkillRunError);
    expect(caught).toMatchObject({
      code: "SELECT_OPTION_FAILED",
      executed_steps: 1,
      submitted: false
    });
    expect((caught as Error).message).toContain(
      "option disappeared"
    );
  });

  it("rejects ambiguous fresh targets instead of guessing", () => {
    expect(() =>
      resolveSiteSkillTarget(
        [
          {
            element_id: "@e1",
            backend_node_id: 1,
            role: "button",
            name: "Continue",
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
        ],
        {
          role: "button",
          accessible_name: "Continue",
          selector_hints: {},
          resolution: "fresh_semantic_then_dom_hint"
        }
      )
    ).toThrow("AMBIGUOUS");
  });

  it("rejects missing required parameters before mutating the page", async () => {
    await expect(
      runSiteSkillRecipe({
        tab_id: 7,
        candidate: candidate(),
        parameters: {
          country: "IN"
        }
      })
    ).rejects.toThrow("PARAMETER_REQUIRED");

    expect(mocks.trustedType).not.toHaveBeenCalled();
    expect(mocks.trustedClick).not.toHaveBeenCalled();
  });
});

describe("api_fetch recipes", () => {
  function apiCandidate(): SiteCandidateSkill {
    const base = candidate();
    return {
      ...base,
      site: { ...base.site, origin: "https://example.com" },
      parameters: [
        {
          name: "api1_q",
          label: "q",
          type: "string",
          required: false,
          sensitive: false,
          source: { form_index: -1, field_name: "q" }
        }
      ],
      recipes: [
        {
          id: "recipe-api-1",
          name: "GET /api/search",
          entry_url: "https://example.com/",
          form_index: -1,
          method: "GET",
          action: "/api/search",
          parameters: ["api1_q"],
          steps: [
            {
              kind: "api_fetch",
              method: "GET",
              path: "/api/search",
              query: [{ key: "q", parameter: "api1_q", default: "a" }],
              response: { format: "json", max_chars: 1000 },
              approval: "none_read_only"
            }
          ],
          verification: { required: true, checks: [] }
        }
      ]
    };
  }

  beforeEach(() => {
    mocks.evaluatePageExpression.mockReset();
    (globalThis as unknown as { chrome: unknown }).chrome = {
      tabs: {
        get: vi.fn(async () => ({ url: "https://example.com/home" }))
      }
    };
  });

  it("fetches the site's own endpoint in-page and returns parsed JSON", async () => {
    mocks.evaluatePageExpression.mockResolvedValue({
      type: "object",
      value: {
        status: 200,
        ok: true,
        content_type: "application/json",
        truncated: false,
        body: '{"items":[1,2]}'
      }
    });
    const run = await runSiteSkillRecipe({
      tab_id: 7,
      candidate: apiCandidate(),
      parameters: { api1_q: "shoes" }
    });
    expect(run.output?.data).toEqual({ items: [1, 2] });
    expect(run.submitted).toBe(false);
    expect(mocks.evaluatePageExpression.mock.calls[0][1]).toContain(
      "https://example.com/api/search?q=shoes"
    );
  });

  it("refuses to run from another origin and surfaces HTTP failures", async () => {
    (globalThis as unknown as { chrome: { tabs: { get: unknown } } }).chrome.tabs.get =
      vi.fn(async () => ({ url: "https://evil.com/" }));
    await expect(
      runSiteSkillRecipe({
        tab_id: 7,
        candidate: apiCandidate(),
        parameters: {}
      })
    ).rejects.toMatchObject({ code: "SITE_SKILL_ORIGIN_MISMATCH" });

    (globalThis as unknown as { chrome: { tabs: { get: unknown } } }).chrome.tabs.get =
      vi.fn(async () => ({ url: "https://example.com/" }));
    mocks.evaluatePageExpression.mockResolvedValue({
      type: "object",
      value: { status: 403, ok: false, content_type: "", truncated: false, body: "" }
    });
    await expect(
      runSiteSkillRecipe({
        tab_id: 7,
        candidate: apiCandidate(),
        parameters: {}
      })
    ).rejects.toMatchObject({ code: "SITE_SKILL_API_HTTP_403" });
  });
});
