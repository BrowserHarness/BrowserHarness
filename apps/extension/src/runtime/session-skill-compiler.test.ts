import { describe, expect, it } from "vitest";
import {
  compileSessionInputs,
  compileSessionToSkill,
  normalizeSessionPlan
} from "./session-skill-compiler";
import type { BrowserTaskSessionEvidence } from "./session-evidence";

function sessionEvidence(): BrowserTaskSessionEvidence {
  return {
    version: 1,
    session_id: "task-compare-1",
    title: "Compare products",
    task: "Search for a mechanical keyboard, compare it in another tab, and add the chosen item to cart.",
    started_at: "2026-09-27T12:00:00.000Z",
    status: "completed",
    start: {
      tab_id: 21,
      url: "https://shop.example/search",
      title: "Search"
    },
    actions: [
      {
        id: "action-1",
        ordinal: 1,
        recorded_at: "2026-09-27T12:00:01.000Z",
        tool: "type",
        input: {
          element_id: "bc-search",
          text: "mechanical keyboard"
        },
        note: "Entering the product search",
        before: {
          tab_id: 21,
          url: "https://shop.example/search",
          title: "Search"
        },
        target: {
          element_id: "bc-search",
          semantic_ref: "@e4",
          tag: "input",
          role: "textbox",
          accessible_name: "Search products",
          type: "search"
        },
        approval: {
          required: false,
          approved: true
        },
        after: {
          tab_id: 21,
          url: "https://shop.example/search",
          title: "Search"
        }
      },
      {
        id: "action-2",
        ordinal: 2,
        recorded_at: "2026-09-27T12:00:02.000Z",
        tool: "open_tab",
        input: {
          url: "https://shop.example/product/keyboard",
          active: false
        },
        note: "Opening the product in another tab",
        before: {
          tab_id: 21,
          url: "https://shop.example/search",
          title: "Search"
        },
        approval: {
          required: false,
          approved: true
        },
        result_tab_id: 22,
        after: {
          tab_id: 22,
          url: "https://shop.example/product/keyboard",
          title: "Mechanical keyboard"
        }
      },
      {
        id: "action-3",
        ordinal: 3,
        recorded_at: "2026-09-27T12:00:03.000Z",
        tool: "click",
        input: {
          tab_id: 22,
          element_id: "bc-add-cart"
        },
        note: "Adding the chosen item to cart",
        before: {
          tab_id: 22,
          url: "https://shop.example/product/keyboard",
          title: "Mechanical keyboard"
        },
        target: {
          element_id: "bc-add-cart",
          semantic_ref: "@e12",
          tag: "button",
          role: "button",
          accessible_name: "Add to cart",
          requires_approval: true,
          approval_reason: "Add this item to the cart"
        },
        approval: {
          required: true,
          approved: true,
          description: "Add this item to the cart"
        },
        after: {
          tab_id: 22,
          url: "https://shop.example/product/keyboard",
          title: "Mechanical keyboard"
        }
      }
    ],
    boundary_action_id: "action-3",
    tab_evidence: [
      {
        tab_id: 21,
        url: "https://shop.example/search",
        title: "Search",
        visible_text: "Search products"
      },
      {
        tab_id: 22,
        url: "https://shop.example/product/keyboard",
        title: "Mechanical keyboard",
        visible_text: "Add to cart"
      }
    ]
  };
}

describe("Browser task Session to Skill compiler", () => {
  it("compiles successful session evidence into a candidate Skill", () => {
    const skill = compileSessionToSkill(sessionEvidence());

    expect(skill).toMatchObject({
      schema_version: 1,
      id: "SK-SESSION-TASK-COMPARE-1",
      slug: "session-compare-products-task-compare",
      name: "Compare products",
      version: "0.1.0",
      status: "candidate",
      lifecycle: {
        auto_promote: false,
        promotion_requires_evaluation: true
      },
      safety: {
        boundary_action_id: "action-3",
        maximum_demonstrated_action_ordinal: 3,
        maximum_demonstrated_plan_index: 2,
        allow_undemonstrated_actions_after_boundary: false,
        approval_policy: "preserve_browserharness_approval_rules"
      }
    });
  });

  it("normalizes raw task tab ids and transient element ids", () => {
    const plan = normalizeSessionPlan(sessionEvidence());

    expect(plan.entry).toEqual({
      url: "https://shop.example/search",
      tab_ref: "tab_1"
    });
    expect(plan.tabs).toEqual([
      { ref: "tab_1", source_tab_id: 21 },
      { ref: "tab_2", source_tab_id: 22 }
    ]);

    expect(plan.steps[2]).toMatchObject({
      source_action_id: "action-3",
      tab_ref: "tab_2",
      tool: "click",
      input: {
        tab_ref: "tab_2"
      },
      target: {
        role: "button",
        accessible_name: "Add to cart",
        recorded_element_ref: "bc-add-cart",
        recorded_semantic_ref: "@e12",
        resolution: "reobserve_semantic_evidence"
      },
      approval: {
        required: true,
        approved: true,
        description: "Add this item to the cart"
      }
    });
    expect(plan.steps[2].input).not.toHaveProperty("element_id");
    expect(plan.steps[2].input).not.toHaveProperty("tab_id");
  });

  it("turns typed text into a reusable parameter rather than a fixed action value", () => {
    const parameters = compileSessionInputs(sessionEvidence());
    expect(parameters).toEqual([
      {
        name: "search_products",
        label: "Search products",
        type: "string",
        required: true,
        source_action_id: "action-1",
        input_key: "text",
        default_example: "mechanical keyboard"
      }
    ]);

    const skill = compileSessionToSkill(sessionEvidence());
    expect(skill.plan.steps[0]).toMatchObject({
      input: {
        text: {
          parameter: "search_products"
        }
      },
      parameter_bindings: [
        {
          input_key: "text",
          parameter: "search_products"
        }
      ]
    });
  });

  it("does not retain password or local upload path examples in compiled provenance", () => {
    const session = sessionEvidence();
    session.actions.splice(
      1,
      0,
      {
        id: "action-password",
        ordinal: 2,
        recorded_at: "2026-09-27T12:00:01.500Z",
        tool: "type",
        input: {
          element_id: "bc-password",
          text: "super-secret"
        },
        note: "Entering password",
        before: {
          tab_id: 21,
          url: "https://shop.example/login",
          title: "Login"
        },
        target: {
          element_id: "bc-password",
          tag: "input",
          role: "textbox",
          accessible_name: "Password",
          type: "password"
        },
        approval: {
          required: false,
          approved: true
        }
      },
      {
        id: "action-upload",
        ordinal: 3,
        recorded_at: "2026-09-27T12:00:01.700Z",
        tool: "upload",
        input: {
          element_id: "@e-file",
          files: ["C:/Users/example/private.pdf"]
        },
        note: "Uploading document",
        before: {
          tab_id: 21,
          url: "https://shop.example/upload",
          title: "Upload"
        },
        target: {
          element_id: "@e-file",
          tag: "input",
          role: "button",
          accessible_name: "Choose file",
          type: "file"
        },
        approval: {
          required: false,
          approved: true
        }
      }
    );
    session.actions.forEach((action, index) => {
      action.ordinal = index + 1;
    });
    session.boundary_action_id = "action-3";

    const skill = compileSessionToSkill(session);
    const password = skill.parameters.find(
      (parameter) => parameter.source_action_id === "action-password"
    );
    const files = skill.parameters.find(
      (parameter) => parameter.source_action_id === "action-upload"
    );

    expect(password).toMatchObject({
      type: "string",
      sensitive: true
    });
    expect(password).not.toHaveProperty("default_example");

    expect(files).toMatchObject({
      type: "string[]",
      sensitive: true
    });
    expect(files).not.toHaveProperty("default_example");

    expect(
      JSON.stringify(skill.provenance.input_examples)
    ).not.toContain("super-secret");
    expect(
      JSON.stringify(skill.provenance.input_examples)
    ).not.toContain("private.pdf");
  });

  it("emits deterministic evaluations for start, input, navigation, tabs, boundary, approval and stale-target recovery", () => {
    const skill = compileSessionToSkill(sessionEvidence());

    expect(skill.evaluations.map((evaluation) => evaluation.id)).toEqual([
      "start-page-recognizable",
      "input-search-products-available",
      "navigation-1-reachable",
      "multi-tab-context-preserved",
      "demonstrated-boundary-reachable",
      "approval-policy-preserved",
      "stale-locator-reobserve"
    ]);

    expect(
      skill.evaluations.find(
        (evaluation) =>
          evaluation.id === "demonstrated-boundary-reachable"
      )
    ).toMatchObject({
      expect: {
        boundary_action_id: "action-3",
        maximum_demonstrated_action_ordinal: 3,
        maximum_demonstrated_plan_index: 2,
        no_actions_after_boundary: true
      }
    });
  });

  it.each([
    {
      name: "incomplete session",
      mutate: (session: BrowserTaskSessionEvidence) => {
        session.status = "stopped";
      },
      error: "SESSION_SKILL_COMPILE_REQUIRES_COMPLETED_SESSION"
    },
    {
      name: "session crossing a manual handoff",
      mutate: (session: BrowserTaskSessionEvidence) => {
        session.manual_handoffs = [
          {
            id: "handoff-1",
            recorded_at: "2026-09-27T12:00:01.250Z",
            reason: "Complete two-factor authentication",
            status: "continued",
            source: "user",
            before: {
              tab_id: 21,
              url: "https://shop.example/login",
              title: "Login"
            },
            after: {
              tab_id: 21,
              url: "https://shop.example/account",
              title: "Account"
            }
          }
        ];
      },
      error:
        "SESSION_SKILL_COMPILE_REQUIRES_MANUAL_HANDOFF_PRECONDITION"
    },
    {
      name: "session without actions",
      mutate: (session: BrowserTaskSessionEvidence) => {
        session.actions = [];
      },
      error: "SESSION_SKILL_COMPILE_REQUIRES_ACTION_EVIDENCE"
    },
    {
      name: "session without boundary",
      mutate: (session: BrowserTaskSessionEvidence) => {
        session.boundary_action_id = undefined;
      },
      error: "SESSION_SKILL_COMPILE_REQUIRES_BOUNDARY"
    },
    {
      name: "session with unknown boundary",
      mutate: (session: BrowserTaskSessionEvidence) => {
        session.boundary_action_id = "missing-action";
      },
      error: "SESSION_SKILL_COMPILE_BOUNDARY_NOT_FOUND"
    },
    {
      name: "session with actions after boundary",
      mutate: (session: BrowserTaskSessionEvidence) => {
        session.boundary_action_id = "action-2";
      },
      error: "SESSION_SKILL_COMPILE_ACTIONS_AFTER_BOUNDARY"
    },
    {
      name: "session containing unapproved action",
      mutate: (session: BrowserTaskSessionEvidence) => {
        session.actions[2].approval.approved = false;
      },
      error: "SESSION_SKILL_COMPILE_CONTAINS_UNAPPROVED_ACTION"
    }
  ])("rejects unsafe $name evidence", ({ mutate, error }) => {
    const session = sessionEvidence();
    mutate(session);
    expect(() => compileSessionToSkill(session)).toThrow(error);
  });
});
