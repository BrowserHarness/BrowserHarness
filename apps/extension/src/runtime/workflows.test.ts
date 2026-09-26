import { beforeEach, describe, expect, it } from "vitest";
import {
  loadWorkflows,
  saveWorkflow,
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
          text: "BrowserCrew"
        }
      ]
    };

    await saveWorkflow(workflow);
    expect(await loadWorkflows()).toEqual([workflow]);
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
