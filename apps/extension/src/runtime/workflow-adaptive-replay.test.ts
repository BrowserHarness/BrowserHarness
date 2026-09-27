import { describe, expect, it, vi } from "vitest";
import {
  replaySavedWorkflowAdaptive,
  supportsAdaptiveWorkflowReplay
} from "./workflow-adaptive-replay";
import type { AdaptiveReplayDependencies } from "./adaptive-replay";
import type {
  PageObservation,
  ToolName,
  ToolResult
} from "./protocol";
import type { SavedWorkflow } from "./workflows";

function workflow(): SavedWorkflow {
  return {
    id: "wf-search",
    version: 3,
    name: "Search products",
    created_at: "2026-09-27T10:00:00.000Z",
    url: "https://shop.example/search",
    end_url: "https://shop.example/search?q=keyboard",
    boundary_step_id: "step-1",
    inputs: [
      {
        name: "search_products",
        label: "Search products",
        default: "mechanical keyboard",
        step_id: "step-1"
      }
    ],
    steps: [
      {
        id: "step-1",
        recorded_at: "2026-09-27T10:00:01.000Z",
        tab_id: 11,
        action: "type",
        locator: {
          tag: "input",
          role: "textbox",
          accessible_name: "Search products",
          input_type: "search",
          semantic_ref: "@recorded-search"
        },
        text: "mechanical keyboard"
      }
    ],
    events: [],
    recording: {
      tab_count: 1,
      event_count: 0,
      dropped_steps: 0,
      dropped_events: 0,
      approximate_bytes: 1024
    }
  };
}

function observation(): PageObservation {
  return {
    tab_id: 101,
    url: "https://shop.example/search",
    title: "Search",
    visible_text: "",
    elements: [
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
    ],
    adapter: "generic-web"
  };
}

describe("SavedWorkflow v3 adaptive replay bridge", () => {
  it("routes v3 workflows through compiler output and fresh browser evidence", async () => {
    const calls: Array<{
      tool: ToolName;
      input: Record<string, unknown>;
    }> = [];

    const dependencies: AdaptiveReplayDependencies = {
      tool: vi.fn(
        async (
          tool: ToolName,
          input: Record<string, unknown> = {}
        ): Promise<ToolResult> => {
          calls.push({ tool, input: structuredClone(input) });

          if (tool === "observe_page") {
            return {
              ok: true,
              data: observation()
            };
          }

          return {
            ok: true,
            data: {}
          };
        }
      ) as unknown as AdaptiveReplayDependencies["tool"],
      requestApproval: vi.fn(async () => true),
      isCancelled: () => false
    };

    const result = await replaySavedWorkflowAdaptive(
      workflow(),
      dependencies,
      {
        parameters: {
          search_products: "wireless keyboard"
        }
      }
    );

    expect(result).toMatchObject({
      status: "completed",
      completed_plan_entries: 1,
      boundary_reached: true,
      tab_map: {
        tab_1: 101
      }
    });

    expect(
      calls.find((call) => call.tool === "type")?.input
    ).toEqual({
      tab_id: 101,
      element_id: "@fresh-search",
      text: "wireless keyboard",
      replace: true
    });
    expect(
      calls.some((call) =>
        JSON.stringify(call.input).includes("@recorded-search")
      )
    ).toBe(false);
    expect(
      calls.some((call) => call.input.tab_id === 11)
    ).toBe(false);
  });

  it("keeps legacy workflow versions out of adaptive replay", async () => {
    const legacy = workflow();
    legacy.version = 2;

    expect(supportsAdaptiveWorkflowReplay(legacy)).toBe(false);

    await expect(
      replaySavedWorkflowAdaptive(
        legacy,
        {
          tool: vi.fn() as unknown as AdaptiveReplayDependencies["tool"],
          requestApproval: vi.fn(async () => true),
          isCancelled: () => false
        }
      )
    ).rejects.toThrow("ADAPTIVE_REPLAY_REQUIRES_WORKFLOW_V3");
  });
});
