import { describe, expect, it } from "vitest";
import {
  compileWorkflowInputs,
  compileWorkflowToSkill,
  normalizeWorkflowPlan
} from "./skill-compiler";
import type { SavedWorkflow } from "./workflows";

function crossTabWorkflow(): SavedWorkflow {
  return {
    id: "wf-cross-tab",
    version: 3,
    name: "Shop for accessories",
    created_at: "2026-09-27T10:00:00.000Z",
    url: "https://shop.example/search",
    end_url: "https://shop.example/product/keyboard",
    boundary_step_id: "step-3",
    steps: [
      {
        id: "step-1",
        recorded_at: "2026-09-27T10:00:00.200Z",
        tab_id: 11,
        action: "type",
        locator: {
          tag: "input",
          role: "textbox",
          accessible_name: "Search products",
          label: "Search products",
          semantic_ref: "@e4",
          attributes: {
            name: "q",
            placeholder: "Search products"
          }
        },
        text: "mechanical keyboard"
      },
      {
        id: "step-2",
        recorded_at: "2026-09-27T10:00:00.300Z",
        tab_id: 11,
        action: "click",
        locator: {
          tag: "a",
          role: "link",
          accessible_name: "Mechanical keyboard",
          semantic_ref: "@e8"
        },
        pointer: { x: 420, y: 280 }
      },
      {
        id: "step-3",
        recorded_at: "2026-09-27T10:00:00.600Z",
        tab_id: 12,
        action: "click",
        locator: {
          tag: "button",
          role: "button",
          accessible_name: "Buy now",
          semantic_ref: "@e12",
          requires_approval: true,
          approval_reason: "This action starts a purchase flow."
        }
      }
    ],
    events: [
      {
        id: "event-nav-1",
        type: "navigation",
        recorded_at: "2026-09-27T10:00:00.100Z",
        tab_id: 11,
        url: "https://shop.example/search",
        transition_type: "typed"
      },
      {
        id: "event-open-1",
        type: "tab_opened",
        recorded_at: "2026-09-27T10:00:00.400Z",
        tab_id: 12,
        opener_tab_id: 11,
        url: "https://shop.example/product/keyboard",
        title: "Mechanical keyboard"
      },
      {
        id: "event-activate-1",
        type: "tab_activated",
        recorded_at: "2026-09-27T10:00:00.500Z",
        tab_id: 12,
        window_id: 3,
        url: "https://shop.example/product/keyboard",
        title: "Mechanical keyboard"
      },
      {
        id: "event-close-1",
        type: "tab_closed",
        recorded_at: "2026-09-27T10:00:00.700Z",
        tab_id: 12
      }
    ],
    recording: {
      tab_count: 2,
      event_count: 4,
      dropped_steps: 0,
      dropped_events: 0,
      approximate_bytes: 4096
    }
  };
}

describe("Watch Me v3 Skill compiler", () => {
  it("compiles a cross-page multi-tab recording into a candidate Skill", () => {
    const skill = compileWorkflowToSkill(crossTabWorkflow());

    expect(skill).toMatchObject({
      schema_version: 1,
      id: "SK-WATCH-WF-CROSS-TAB",
      slug: "watch-shop-for-accessories-wf-cross-tab",
      name: "Shop for accessories",
      version: "0.1.0",
      status: "candidate",
      lifecycle: {
        auto_promote: false,
        promotion_requires_evaluation: true
      },
      safety: {
        boundary_step_id: "step-3",
        maximum_demonstrated_action_ordinal: 3,
        maximum_demonstrated_plan_index: 5,
        allow_undemonstrated_actions_after_boundary: false,
        approval_policy: "preserve_browserharness_approval_rules"
      }
    });

    expect(skill.plan.entry).toEqual({
      url: "https://shop.example/search",
      tab_ref: "tab_1"
    });
    expect(skill.plan.tabs).toEqual([
      { ref: "tab_1", source_tab_id: 11 },
      { ref: "tab_2", source_tab_id: 12 }
    ]);
    expect(skill.plan.steps.map((entry) => entry.kind)).toEqual([
      "navigation",
      "action",
      "action",
      "tab_opened",
      "tab_activated",
      "action",
      "tab_closed"
    ]);
  });

  it("turns recorded text into an explicit reusable Skill parameter", () => {
    const skill = compileWorkflowToSkill(crossTabWorkflow());

    expect(skill.parameters).toEqual([
      {
        name: "search_products",
        label: "Search products",
        type: "string",
        required: true,
        default_example: "mechanical keyboard",
        source_step_id: "step-1"
      }
    ]);

    const typeAction = skill.plan.steps.find(
      (entry) =>
        entry.kind === "action" && entry.source_step_id === "step-1"
    );

    expect(typeAction).toMatchObject({
      kind: "action",
      action: "type",
      tab_ref: "tab_1",
      parameter: "search_products",
      recorded_example: "mechanical keyboard",
      target: {
        role: "textbox",
        accessible_name: "Search products",
        recorded_semantic_ref: "@e4"
      }
    });
  });

  it("normalizes raw tab ids into portable tab refs while retaining source provenance", () => {
    const plan = normalizeWorkflowPlan(crossTabWorkflow());

    expect(plan.tabs).toEqual([
      { ref: "tab_1", source_tab_id: 11 },
      { ref: "tab_2", source_tab_id: 12 }
    ]);

    expect(plan.steps).toContainEqual(
      expect.objectContaining({
        kind: "tab_opened",
        source_event_id: "event-open-1",
        tab_ref: "tab_2",
        opener_tab_ref: "tab_1"
      })
    );

    expect(plan.steps).toContainEqual(
      expect.objectContaining({
        kind: "tab_activated",
        source_event_id: "event-activate-1",
        tab_ref: "tab_2",
        window_id: 3
      })
    );
  });

  it("preserves approval semantics and the demonstrated action boundary", () => {
    const skill = compileWorkflowToSkill(crossTabWorkflow());
    const finalAction = skill.plan.steps.find(
      (entry) =>
        entry.kind === "action" && entry.source_step_id === "step-3"
    );

    expect(finalAction).toMatchObject({
      kind: "action",
      action: "click",
      approval: {
        required: true,
        reason: "This action starts a purchase flow."
      }
    });

    expect(skill.provenance).toMatchObject({
      source_kind: "watch_me_v3",
      source_workflow_id: "wf-cross-tab",
      source_workflow_version: 3,
      boundary_step_id: "step-3",
      action_count: 3,
      context_event_count: 4,
      recording: {
        tab_count: 2,
        event_count: 4,
        dropped_steps: 0,
        dropped_events: 0,
        approximate_bytes: 4096
      }
    });
  });

  it("generates deterministic candidate evaluations from recording evidence", () => {
    const skill = compileWorkflowToSkill(crossTabWorkflow());

    expect(skill.evaluations.map((item) => item.id)).toEqual([
      "start-page-recognizable",
      "input-search-products-locatable",
      "navigation-1-reachable",
      "multi-tab-context-preserved",
      "demonstrated-boundary-reachable",
      "approval-policy-preserved",
      "stale-locator-reobserve"
    ]);

    expect(
      skill.evaluations.find(
        (item) => item.id === "demonstrated-boundary-reachable"
      )
    ).toMatchObject({
      kind: "boundary",
      expect: {
        boundary_step_id: "step-3",
        maximum_demonstrated_action_ordinal: 3,
        maximum_demonstrated_plan_index: 5,
        no_actions_after_boundary: true
      }
    });
  });

  it("uses saved workflow inputs when the recorder already inferred them", () => {
    const workflow = crossTabWorkflow();
    workflow.inputs = [
      {
        name: "query",
        label: "Product query",
        default: "mechanical keyboard",
        step_id: "step-1"
      }
    ];

    expect(compileWorkflowInputs(workflow)).toEqual([
      {
        name: "query",
        label: "Product query",
        type: "string",
        required: true,
        default_example: "mechanical keyboard",
        source_step_id: "step-1"
      }
    ]);
  });

  it.each([
    {
      name: "legacy workflow",
      mutate: (workflow: SavedWorkflow) => {
        workflow.version = 2;
      },
      error: "SKILL_COMPILE_REQUIRES_WORKFLOW_V3"
    },
    {
      name: "workflow without actions",
      mutate: (workflow: SavedWorkflow) => {
        workflow.steps = [];
      },
      error: "SKILL_COMPILE_REQUIRES_ACTIONABLE_EVIDENCE"
    },
    {
      name: "workflow without step ids",
      mutate: (workflow: SavedWorkflow) => {
        workflow.steps[0] = { ...workflow.steps[0], id: undefined };
      },
      error: "SKILL_COMPILE_REQUIRES_STEP_IDS"
    },
    {
      name: "workflow without a boundary",
      mutate: (workflow: SavedWorkflow) => {
        workflow.boundary_step_id = undefined;
      },
      error: "SKILL_COMPILE_REQUIRES_BOUNDARY_STEP_ID"
    },
    {
      name: "workflow with an unknown boundary",
      mutate: (workflow: SavedWorkflow) => {
        workflow.boundary_step_id = "missing-step";
      },
      error: "SKILL_COMPILE_BOUNDARY_NOT_FOUND"
    },
    {
      name: "workflow with accepted actions after its boundary",
      mutate: (workflow: SavedWorkflow) => {
        workflow.boundary_step_id = "step-2";
      },
      error: "SKILL_COMPILE_ACTIONS_AFTER_BOUNDARY"
    }
  ])("rejects unsafe or incomplete $name evidence", ({ mutate, error }) => {
    const workflow = crossTabWorkflow();
    mutate(workflow);

    expect(() => compileWorkflowToSkill(workflow)).toThrow(error);
  });
});
