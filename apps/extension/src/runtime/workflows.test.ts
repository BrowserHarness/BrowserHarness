import { beforeEach, describe, expect, it } from "vitest";
import {
  finalizeRecordedSteps,
  inferWorkflowInputs,
  loadWorkflows,
  saveWorkflow,
  type RecordedWorkflowStep,
  type SavedWorkflow
} from "./workflows";

let store: Record<string, unknown>;

beforeEach(() => {
  store = {};
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: store[key] }),
          set: async (value: Record<string, unknown>) => {
            Object.assign(store, value);
          }
        }
      }
    }
  });
});

describe("workflow storage", () => {
  it("saves and reloads a semantic workflow", async () => {
    const workflow: SavedWorkflow = {
      id: "wf-1",
      name: "Search workflow",
      created_at: "2026-09-26T00:00:00.000Z",
      url: "https://example.com",
      steps: [
        {
          action: "type",
          locator: {
            tag: "input",
            role: "textbox",
            accessible_name: "Search"
          },
          text: "BrowserHarness"
        }
      ]
    };

    await saveWorkflow(workflow);
    expect(await loadWorkflows()).toEqual([workflow]);
  });

  it("infers reusable workflow inputs from recorded text steps", () => {
    const steps: RecordedWorkflowStep[] = [
      {
        id: "step-1",
        action: "type",
        locator: {
          tag: "input",
          role: "textbox",
          accessible_name: "Search products",
          label: "Search products"
        },
        text: "mechanical keyboard"
      },
      {
        id: "step-2",
        action: "type",
        locator: {
          tag: "input",
          role: "textbox",
          accessible_name: "Search products",
          label: "Search products"
        },
        text: "wireless mouse"
      }
    ];

    expect(inferWorkflowInputs(steps)).toEqual([
      {
        name: "search_products",
        label: "Search products",
        default: "mechanical keyboard",
        step_id: "step-1"
      },
      {
        name: "search_products_2",
        label: "Search products",
        default: "wireless mouse",
        step_id: "step-2"
      }
    ]);
  });

  it("adds readable descriptions without mutating recorded actions", () => {
    const steps: RecordedWorkflowStep[] = [
      {
        action: "click",
        locator: {
          tag: "button",
          role: "button",
          accessible_name: "Search"
        }
      },
      {
        action: "key",
        key: "Enter",
        locator: {
          tag: "input",
          role: "textbox",
          accessible_name: "Query"
        }
      }
    ];

    expect(finalizeRecordedSteps(steps)).toEqual([
      expect.objectContaining({
        action: "click",
        description: "Click Search"
      }),
      expect.objectContaining({
        action: "key",
        description: "Press Enter in Query"
      })
    ]);
  });

  it("replaces an existing workflow version by id", async () => {
    const base: SavedWorkflow = {
      id: "wf-1",
      name: "Old",
      created_at: "2026-09-26T00:00:00.000Z",
      url: "https://example.com",
      steps: []
    };
    await saveWorkflow(base);
    await saveWorkflow({ ...base, name: "Updated" });

    const saved = await loadWorkflows();
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe("Updated");
  });
});
