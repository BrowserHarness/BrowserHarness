import { beforeEach, describe, expect, it } from "vitest";
import {
  deleteTaskEpisodeMemory,
  getTaskEpisodeMemory,
  listTaskEpisodeMemory,
  saveTaskEpisodeMemory,
  searchTaskEpisodeMemory,
  taskEpisodeFromSession
} from "./task-memory";
import type { BrowserTaskSessionEvidence } from "./session-evidence";

let store: Record<string, unknown>;

function evidence(): BrowserTaskSessionEvidence {
  return {
    version: 1,
    session_id: "session-1",
    title: "Submit checkout",
    task: "Finish the checkout form",
    started_at: "2026-09-28T08:00:00.000Z",
    status: "completed",
    start: {
      tab_id: 1,
      url: "https://shop.example/checkout",
      title: "Checkout"
    },
    actions: [
      {
        id: "action-1",
        ordinal: 1,
        recorded_at: "2026-09-28T08:00:01.000Z",
        tool: "type",
        input: {
          element_id: "@e1",
          text: "super-secret-card-data"
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
        recorded_at: "2026-09-28T08:00:02.000Z",
        tool: "site_skill",
        input: {
          action: "run",
          id: "SK-SITE-CHECKOUT",
          revision_id: "SK-SITE-CHECKOUT:r2",
          parameters: {
            password: "<redacted>"
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
        },
        after: {
          tab_id: 1,
          url: "https://shop.example/done",
          title: "Done"
        }
      }
    ],
    manual_handoffs: [
      {
        id: "handoff-1",
        recorded_at: "2026-09-28T08:00:01.500Z",
        reason: "Complete 2FA",
        status: "continued",
        source: "user",
        before: {
          tab_id: 1,
          url: "https://shop.example/checkout",
          title: "Checkout"
        }
      }
    ],
    boundary_action_id: "action-2",
    tab_evidence: [
      {
        tab_id: 1,
        url: "https://shop.example/done",
        title: "Done",
        visible_text: "Order complete"
      }
    ]
  };
}

beforeEach(() => {
  store = {};
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: store[key] }),
          set: async (value: Record<string, unknown>) => {
            Object.assign(store, structuredClone(value));
          }
        }
      }
    }
  });
});

describe("task episode memory", () => {
  it("converts session evidence to a compact episode without action payloads", () => {
    const episode = taskEpisodeFromSession(
      evidence(),
      "2026-09-28T08:01:00.000Z"
    );

    expect(episode).toMatchObject({
      id: "episode:session-1:2026-09-28T08:00:00.000Z",
      kind: "task_episode",
      status: "completed",
      action_count: 2,
      manual_handoff_count: 1,
      sensitive_payloads_removed: true,
      tools: ["type", "site_skill"],
      targets: ["Email"],
      sites: ["https://shop.example"],
      skill_refs: [
        {
          id: "SK-SITE-CHECKOUT",
          action: "run",
          revision_id: "SK-SITE-CHECKOUT:r2"
        }
      ]
    });
    expect(JSON.stringify(episode)).not.toContain(
      "super-secret-card-data"
    );
    expect(JSON.stringify(episode)).not.toContain(
      "<redacted>"
    );
  });

  it("persists bounded delegation provenance and delegated sources", async () => {
    const session = evidence();
    session.actions.push({
      id: "action-3",
      ordinal: 3,
      recorded_at: "2026-09-28T08:00:03.000Z",
      tool: "agent",
      input: {
        tasks: ["Read independent source"]
      },
      note: "Delegate research",
      before: {
        tab_id: 1,
        url: "https://shop.example/done",
        title: "Done"
      },
      approval: {
        required: false,
        approved: true
      },
      delegation: {
        worker_count: 1,
        completed_count: 1,
        non_completed_count: 0,
        workers: [
          {
            index: 0,
            task: "Read independent source",
            session_id: "session-1:worker:1",
            status: "completed",
            sources: [
              {
                url:
                  "https://research.example/report?id=42",
                title: "Independent Report"
              }
            ],
            tools_used: ["open_tab", "read_page"]
          }
        ]
      }
    });

    const saved = await saveTaskEpisodeMemory(session);

    expect(saved.delegations).toEqual([
      {
        action_id: "action-3",
        worker_index: 0,
        task: "Read independent source",
        session_id: "session-1:worker:1",
        status: "completed",
        sources: [
          {
            url:
              "https://research.example/report?id=42",
            title: "Independent Report"
          }
        ],
        tools_used: ["open_tab", "read_page"]
      }
    ]);
    expect(saved.sites).toContain(
      "https://research.example"
    );
    expect(
      (await searchTaskEpisodeMemory("Independent Report"))[0]
        ?.id
    ).toBe(saved.id);
  });

  it("persists, searches, retrieves and deletes episodic memory", async () => {
    const saved = await saveTaskEpisodeMemory(evidence());

    expect(await listTaskEpisodeMemory()).toHaveLength(1);
    expect(
      (await searchTaskEpisodeMemory("checkout skill"))[0]?.id
    ).toBe(saved.id);
    expect(
      (await searchTaskEpisodeMemory("shop.example"))[0]?.id
    ).toBe(saved.id);
    expect(await getTaskEpisodeMemory(saved.id)).toEqual(saved);
    expect(await deleteTaskEpisodeMemory(saved.id)).toBe(true);
    expect(await getTaskEpisodeMemory(saved.id)).toBeNull();
  });
});
