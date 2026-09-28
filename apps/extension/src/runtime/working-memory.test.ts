import { beforeEach, describe, expect, it } from "vitest";
import {
  buildBrowserWorkingMemory,
  clearBrowserWorkingMemory,
  getBrowserWorkingMemory,
  listBrowserWorkingMemory,
  saveBrowserWorkingMemory
} from "./working-memory";
import type {
  BrowserSessionActionEvidence,
  BrowserSessionManualHandoffEvidence
} from "./session-evidence";

let store: Record<string, unknown>;

beforeEach(() => {
  store = {};
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        session: {
          get: async (key: string) => ({
            [key]: store[key]
          }),
          set: async (value: Record<string, unknown>) => {
            Object.assign(store, structuredClone(value));
          }
        }
      }
    }
  });
});

describe("Browser working memory", () => {
  it("builds active task state without retaining tool input payloads", () => {
    const actions: BrowserSessionActionEvidence[] = [
      {
        id: "action-1",
        ordinal: 1,
        recorded_at: "2026-09-28T09:00:01.000Z",
        tool: "type",
        input: {
          element_id: "@e1",
          text: "never-store-this-secret"
        },
        note: "Enter email",
        before: {
          tab_id: 1,
          url: "https://shop.example/checkout",
          title: "Checkout"
        },
        target: {
          element_id: "@e1",
          tag: "input",
          role: "textbox",
          accessible_name: "Email"
        },
        approval: {
          required: false,
          approved: true
        },
        after: {
          tab_id: 1,
          url: "https://shop.example/checkout",
          title: "Checkout"
        }
      },
      {
        id: "action-2",
        ordinal: 2,
        recorded_at: "2026-09-28T09:00:02.000Z",
        tool: "site_skill",
        input: {
          action: "run",
          id: "SK-SITE-CHECKOUT",
          revision_id: "SK-SITE-CHECKOUT:r2",
          parameters: {
            password: "also-never-store"
          }
        },
        note: "Run checkout Skill",
        before: {
          tab_id: 1,
          url: "https://shop.example/checkout",
          title: "Checkout"
        },
        approval: {
          required: true,
          approved: true
        }
      }
    ];

    const handoffs: BrowserSessionManualHandoffEvidence[] = [
      {
        id: "handoff-1",
        recorded_at: "2026-09-28T09:00:01.500Z",
        reason: "Complete 2FA",
        status: "continued",
        source: "user",
        before: {
          tab_id: 1,
          url: "https://shop.example/checkout",
          title: "Checkout"
        }
      }
    ];

    const memory = buildBrowserWorkingMemory({
      session_id: "session-1",
      title: "Checkout",
      task: "Finish checkout",
      started_at: "2026-09-28T09:00:00.000Z",
      current: {
        tab_id: 1,
        url: "https://shop.example/checkout",
        title: "Checkout"
      },
      actions,
      manual_handoffs: handoffs,
      updated_at: "2026-09-28T09:00:03.000Z"
    });

    expect(memory).toMatchObject({
      session_id: "session-1",
      status: "active",
      action_count: 2,
      recent_actions: [
        {
          ordinal: 1,
          tool: "type",
          target: "Email"
        },
        {
          ordinal: 2,
          tool: "site_skill"
        }
      ],
      manual_handoffs: [
        {
          reason: "Complete 2FA",
          status: "continued",
          source: "user"
        }
      ],
      sites: ["https://shop.example"],
      skill_refs: [
        {
          id: "SK-SITE-CHECKOUT",
          action: "run",
          revision_id: "SK-SITE-CHECKOUT:r2"
        }
      ],
      sensitive_payloads_removed: true
    });

    const serialized = JSON.stringify(memory);
    expect(serialized).not.toContain(
      "never-store-this-secret"
    );
    expect(serialized).not.toContain("also-never-store");
  });

  it("saves, lists, reads and clears active task state", async () => {
    const memory = buildBrowserWorkingMemory({
      session_id: "session-2",
      title: "Research",
      task: "Compare plans",
      started_at: "2026-09-28T09:10:00.000Z",
      current: {
        tab_id: 2,
        url: "https://example.com/plans",
        title: "Plans"
      },
      actions: []
    });

    await saveBrowserWorkingMemory(memory);

    expect(
      await getBrowserWorkingMemory("session-2")
    ).toEqual(memory);
    expect(await listBrowserWorkingMemory()).toEqual([
      memory
    ]);
    expect(
      await clearBrowserWorkingMemory("session-2")
    ).toBe(true);
    expect(
      await getBrowserWorkingMemory("session-2")
    ).toBeNull();
  });
});
