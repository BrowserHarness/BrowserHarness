import { describe, expect, it, vi } from "vitest";
import {
  matchAdaptiveAxTarget,
  matchAdaptiveDomTarget,
  replayCandidateSkill,
  type AdaptiveReplayDependencies
} from "./adaptive-replay";
import type {
  CandidateSkill,
  CandidateSkillTarget
} from "./skill-compiler";
import type {
  PageObservation,
  ToolName,
  ToolResult
} from "./protocol";

function observation(
  tabId: number,
  url: string,
  elements: PageObservation["elements"]
): PageObservation {
  return {
    tab_id: tabId,
    url,
    title: url.includes("/product") ? "Product" : "Search",
    visible_text: "",
    elements,
    adapter: "generic-web"
  };
}

function skill(): CandidateSkill {
  return {
    schema_version: 1,
    id: "SK-WATCH-WF-1",
    slug: "watch-shop-wf-1",
    name: "Shop",
    version: "0.1.0",
    status: "candidate",
    lifecycle: {
      auto_promote: false,
      promotion_requires_evaluation: true
    },
    parameters: [
      {
        name: "search_products",
        label: "Search products",
        type: "string",
        required: true,
        default_example: "mechanical keyboard",
        source_step_id: "step-1"
      }
    ],
    plan: {
      entry: {
        url: "https://shop.example/search",
        tab_ref: "tab_1"
      },
      tabs: [
        { ref: "tab_1", source_tab_id: 11 },
        { ref: "tab_2", source_tab_id: 12 }
      ],
      steps: [
        {
          kind: "navigation",
          source_event_id: "event-nav",
          recorded_at: "2026-09-27T10:00:00.000Z",
          tab_ref: "tab_1",
          url: "https://shop.example/search"
        },
        {
          kind: "action",
          source_step_id: "step-1",
          recorded_at: "2026-09-27T10:00:01.000Z",
          tab_ref: "tab_1",
          action: "type",
          description: "Enter text in Search products",
          target: {
            tag: "input",
            role: "textbox",
            accessible_name: "Search products",
            input_type: "search",
            recorded_semantic_ref: "@e4"
          },
          parameter: "search_products",
          recorded_example: "mechanical keyboard",
          approval: {
            required: false
          }
        },
        {
          kind: "tab_opened",
          source_event_id: "event-open",
          recorded_at: "2026-09-27T10:00:02.000Z",
          tab_ref: "tab_2",
          opener_tab_ref: "tab_1",
          url: "https://shop.example/product/keyboard",
          title: "Product"
        },
        {
          kind: "action",
          source_step_id: "step-2",
          recorded_at: "2026-09-27T10:00:03.000Z",
          tab_ref: "tab_2",
          action: "click",
          description: "Click Add to cart",
          target: {
            tag: "button",
            role: "button",
            accessible_name: "Add to cart",
            recorded_semantic_ref: "@e12"
          },
          approval: {
            required: true,
            reason: "Add this item to the cart"
          }
        },
        {
          kind: "tab_closed",
          source_event_id: "event-close",
          recorded_at: "2026-09-27T10:00:04.000Z",
          tab_ref: "tab_2"
        }
      ]
    },
    safety: {
      boundary_step_id: "step-2",
      maximum_demonstrated_action_ordinal: 2,
      maximum_demonstrated_plan_index: 3,
      allow_undemonstrated_actions_after_boundary: false,
      approval_policy: "preserve_browsercrew_approval_rules"
    },
    provenance: {
      source_kind: "watch_me_v3",
      source_workflow_id: "wf-1",
      source_workflow_version: 3,
      recorded_at: "2026-09-27T10:00:00.000Z",
      start_url: "https://shop.example/search",
      end_url: "https://shop.example/product/keyboard",
      boundary_step_id: "step-2",
      action_count: 2,
      context_event_count: 3,
      input_examples: [
        {
          name: "search_products",
          value: "mechanical keyboard",
          source_step_id: "step-1"
        }
      ]
    },
    evaluations: []
  };
}

function harness(options: {
  initialUrl?: string;
  approve?: boolean;
  productElements?: PageObservation["elements"];
  searchElements?: PageObservation["elements"];
  axElements?: Array<{
    element_id: string;
    role: string;
    name: string;
    disabled?: boolean;
  }>;
}) {
  const calls: Array<{
    tool: ToolName;
    input: Record<string, unknown>;
  }> = [];

  const searchElements =
    options.searchElements ||
    [
      {
        element_id: "@fresh-search",
        semantic_ref: "@fresh-search",
        tag: "input",
        role: "textbox",
        accessible_name: "Search products",
        type: "search",
        visible: true,
        disabled: false
      }
    ];

  const productElements =
    options.productElements ||
    [
      {
        element_id: "@fresh-cart",
        semantic_ref: "@fresh-cart",
        tag: "button",
        role: "button",
        accessible_name: "Add to cart",
        visible: true,
        disabled: false
      }
    ];

  const tool = vi.fn(
    async (
      name: ToolName,
      input: Record<string, unknown> = {}
    ): Promise<ToolResult> => {
      calls.push({ tool: name, input: structuredClone(input) });

      if (name === "observe_page") {
        const tabId =
          typeof input.tab_id === "number" ? input.tab_id : 101;
        const isProduct = tabId === 202;
        return {
          ok: true,
          data: observation(
            tabId,
            isProduct
              ? "https://shop.example/product/keyboard"
              : options.initialUrl ||
                  "https://shop.example/search",
            isProduct ? productElements : searchElements
          )
        };
      }

      if (name === "find_tab") {
        return {
          ok: false,
          error: {
            code: "TAB_NOT_FOUND",
            message: "not found"
          }
        };
      }

      if (name === "open_tab") {
        return {
          ok: true,
          data: {
            tab_id: 202,
            url: input.url
          }
        };
      }

      if (name === "ax_snapshot") {
        return {
          ok: true,
          data: {
            elements: options.axElements || []
          }
        };
      }

      return {
        ok: true,
        data: {
          ...(typeof input.tab_id === "number"
            ? { tab_id: input.tab_id }
            : {})
        }
      };
    }
  );

  const requestApproval = vi.fn(
    async () => options.approve ?? true
  );

  const dependencies: AdaptiveReplayDependencies = {
    tool:
      tool as unknown as AdaptiveReplayDependencies["tool"],
    requestApproval,
    isCancelled: () => false
  };

  return { dependencies, calls, requestApproval };
}

describe("adaptive candidate Skill replay", () => {
  it("remaps logical tabs, resolves fresh targets, binds inputs and stops at the demonstrated boundary", async () => {
    const h = harness({ approve: true });

    const result = await replayCandidateSkill(
      skill(),
      h.dependencies,
      {
        parameters: {
          search_products: "wireless keyboard"
        }
      }
    );

    expect(result).toMatchObject({
      status: "completed",
      completed_plan_entries: 4,
      boundary_reached: true,
      tab_map: {
        tab_1: 101,
        tab_2: 202
      }
    });

    const typed = h.calls.find(
      (call) => call.tool === "type"
    );
    expect(typed?.input).toMatchObject({
      tab_id: 101,
      element_id: "@fresh-search",
      text: "wireless keyboard",
      replace: true
    });

    const clicked = h.calls.find(
      (call) => call.tool === "click"
    );
    expect(clicked?.input).toMatchObject({
      tab_id: 202,
      element_id: "@fresh-cart"
    });

    expect(
      h.calls.some((call) =>
        JSON.stringify(call.input).includes("@e4")
      )
    ).toBe(false);
    expect(
      h.calls.some((call) =>
        JSON.stringify(call.input).includes("@e12")
      )
    ).toBe(false);
    expect(
      h.calls.some(
        (call) =>
          call.tool === "close_tab" ||
          call.input.tab_id === 11 ||
          call.input.tab_id === 12
      )
    ).toBe(false);
    expect(
      h.calls.filter((call) => call.tool === "find_tab")
    ).toHaveLength(0);
    expect(
      h.calls.filter((call) => call.tool === "open_tab")
    ).toHaveLength(1);
    expect(h.requestApproval).toHaveBeenCalledWith(
      "Add this item to the cart"
    );
  });

  it("falls back to a fresh AX snapshot when DOM semantics cannot resolve the target", async () => {
    const candidate = skill();
    candidate.plan.steps = [
      {
        kind: "action",
        source_step_id: "step-2",
        tab_ref: "tab_1",
        action: "click",
        description: "Click Continue",
        target: {
          tag: "button",
          role: "button",
          accessible_name: "Continue",
          recorded_semantic_ref: "@old"
        },
        approval: {
          required: false
        }
      }
    ];
    candidate.safety = {
      ...candidate.safety,
      boundary_step_id: "step-2",
      maximum_demonstrated_action_ordinal: 1,
      maximum_demonstrated_plan_index: 0
    };

    const h = harness({
      searchElements: [],
      axElements: [
        {
          element_id: "@e9",
          role: "button",
          name: "Continue"
        }
      ]
    });

    const result = await replayCandidateSkill(
      candidate,
      h.dependencies
    );

    expect(result.status).toBe("completed");
    expect(
      h.calls.find(
        (call) => call.tool === "trusted_click"
      )?.input
    ).toMatchObject({
      tab_id: 101,
      element_id: "@e9"
    });
  });

  it("does not execute a recorded consequential action when approval is denied", async () => {
    const h = harness({ approve: false });

    const result = await replayCandidateSkill(
      skill(),
      h.dependencies
    );

    expect(result.status).toBe("approval-cancelled");
    expect(result.boundary_reached).toBe(false);
    expect(
      h.calls.some((call) => call.tool === "click")
    ).toBe(false);
  });

  it("uses current-page approval metadata even when the recording did not require approval", async () => {
    const candidate = skill();
    const click = candidate.plan.steps[3];
    if (click.kind !== "action") {
      throw new Error("fixture action missing");
    }
    click.approval = { required: false };

    const h = harness({
      approve: false,
      productElements: [
        {
          element_id: "@fresh-cart",
          semantic_ref: "@fresh-cart",
          tag: "button",
          role: "button",
          accessible_name: "Add to cart",
          visible: true,
          disabled: false,
          requires_approval: true,
          approval_reason: "Current page requires approval"
        }
      ]
    });

    const result = await replayCandidateSkill(
      candidate,
      h.dependencies
    );

    expect(result.status).toBe("approval-cancelled");
    expect(h.requestApproval).toHaveBeenCalledWith(
      "Current page requires approval"
    );
  });

  it("uses a candidate parameter default when no override is supplied", async () => {
    const h = harness({ approve: true });

    await replayCandidateSkill(skill(), h.dependencies);

    expect(
      h.calls.find((call) => call.tool === "type")?.input
    ).toMatchObject({
      text: "mechanical keyboard"
    });
  });

  it("re-establishes the recorded start page from explicit plan context", async () => {
    const candidate = skill();
    const recordedType = candidate.plan.steps[1];
    if (
      recordedType.kind !== "action" ||
      recordedType.action !== "type"
    ) {
      throw new Error("fixture type action missing");
    }
    candidate.plan.steps = [recordedType];
    candidate.safety = {
      ...candidate.safety,
      boundary_step_id: recordedType.source_step_id,
      maximum_demonstrated_action_ordinal: 1,
      maximum_demonstrated_plan_index: 0
    };

    const h = harness({
      initialUrl: "https://other.example/home",
      approve: true
    });

    await replayCandidateSkill(candidate, h.dependencies);

    expect(
      h.calls.find(
        (call) =>
          call.tool === "navigate" &&
          call.input.url ===
            "https://shop.example/search"
      )?.input
    ).toMatchObject({
      tab_id: 101
    });
    expect(
      h.calls.find((call) => call.tool === "type")?.input
    ).toMatchObject({
      tab_id: 101,
      element_id: "@fresh-search"
    });
  });

  it("refuses ambiguous fresh DOM matches instead of guessing", () => {
    const target: CandidateSkillTarget = {
      tag: "button",
      role: "button",
      accessible_name: "Continue"
    };
    const page = observation(
      1,
      "https://example.com",
      [
        {
          element_id: "@e1",
          tag: "button",
          role: "button",
          accessible_name: "Continue",
          visible: true,
          disabled: false
        },
        {
          element_id: "@e2",
          tag: "button",
          role: "button",
          accessible_name: "Continue",
          visible: true,
          disabled: false
        }
      ]
    );

    expect(matchAdaptiveDomTarget(target, page)).toBeNull();
  });

  it("refuses ambiguous AX matches instead of guessing", () => {
    const target: CandidateSkillTarget = {
      tag: "button",
      role: "button",
      accessible_name: "Continue"
    };

    expect(
      matchAdaptiveAxTarget(target, {
        elements: [
          {
            element_id: "@e1",
            role: "button",
            name: "Continue"
          },
          {
            element_id: "@e2",
            role: "button",
            name: "Continue"
          }
        ]
      })
    ).toBeNull();
  });
});
