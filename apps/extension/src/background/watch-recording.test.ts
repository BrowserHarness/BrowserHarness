import { beforeEach, describe, expect, it } from "vitest";
import {
  appendWatchEvent,
  appendWatchStep,
  getWatchRecording,
  startWatchRecording,
  stopWatchRecording,
  trackWatchTab,
  watchRecordingLimits,
  watchRecordingSummary
} from "./watch-recording";
import type { RecordedWorkflowStep } from "../runtime/workflows";

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
            Object.assign(store, value);
          },
          remove: async (key: string) => {
            delete store[key];
          }
        }
      }
    }
  });
});

function rootTab(): chrome.tabs.Tab {
  return {
    id: 7,
    index: 0,
    pinned: false,
    highlighted: true,
    active: true,
    incognito: false,
    selected: true,
    discarded: false,
    frozen: false,
    autoDiscardable: true,
    windowId: 1,
    groupId: -1,
    status: "complete",
    url: "https://example.com/start",
    title: "Start"
  };
}

function clickStep(name: string): RecordedWorkflowStep {
  return {
    action: "click",
    url: "https://example.com/start",
    locator: {
      tag: "button",
      role: "button",
      accessible_name: name
    }
  };
}

describe("background Watch Me recording session", () => {
  it("starts with the root tab and persists outside page lifetime", async () => {
    const session = await startWatchRecording(rootTab());

    expect(session).toMatchObject({
      root_tab_id: 7,
      current_tab_id: 7,
      start_url: "https://example.com/start",
      tab_ids: [7],
      steps: []
    });
    expect(session.events[0]).toMatchObject({
      type: "tab_activated",
      tab_id: 7,
      window_id: 1
    });

    expect(await getWatchRecording()).toEqual(session);
  });

  it("serializes concurrent cross-tab steps without losing actions", async () => {
    await startWatchRecording(rootTab());
    await trackWatchTab(8);

    await Promise.all([
      appendWatchStep(7, clickStep("First")),
      appendWatchStep(8, clickStep("Second")),
      appendWatchStep(7, clickStep("Third"))
    ]);

    const session = await getWatchRecording();

    expect(session?.steps).toHaveLength(3);
    expect(
      new Set(session?.steps.map((step) => step.locator?.accessible_name))
    ).toEqual(new Set(["First", "Second", "Third"]));
    expect(new Set(session?.steps.map((step) => step.tab_id))).toEqual(
      new Set([7, 8])
    );
    expect(session?.boundary_step_id).toBe(
      session?.steps.at(-1)?.id
    );
  });

  it("records navigation and tab context separately from action steps", async () => {
    await startWatchRecording(rootTab());

    await appendWatchEvent({
      type: "navigation",
      tab_id: 7,
      url: "https://example.com/next",
      transition_type: "link"
    });
    await appendWatchEvent({
      type: "tab_opened",
      tab_id: 9,
      opener_tab_id: 7,
      url: "https://example.org"
    });

    const session = await getWatchRecording();

    expect(session?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "navigation",
          tab_id: 7,
          url: "https://example.com/next"
        }),
        expect.objectContaining({
          type: "tab_opened",
          tab_id: 9,
          opener_tab_id: 7
        })
      ])
    );
    expect(session?.tab_ids).toContain(9);
  });

  it("stops atomically and preserves the final actionable boundary", async () => {
    await startWatchRecording(rootTab());
    await appendWatchStep(7, clickStep("Finish"));

    const completed = await stopWatchRecording();

    expect(completed?.steps.at(-1)?.locator?.accessible_name).toBe(
      "Finish"
    );
    expect(completed?.boundary_step_id).toBe(
      completed?.steps.at(-1)?.id
    );
    expect(await getWatchRecording()).toBeNull();
  });

  it("reports bounded evidence limits and recording summary", async () => {
    const limits = watchRecordingLimits();
    expect(limits.max_steps).toBeGreaterThanOrEqual(500);
    expect(limits.max_events).toBeGreaterThanOrEqual(1000);
    expect(limits.max_approximate_bytes).toBeGreaterThanOrEqual(
      1_000_000
    );

    const session = await startWatchRecording(rootTab());
    await appendWatchStep(7, clickStep("One"));

    const current = await getWatchRecording();
    expect(current).not.toBeNull();
    expect(watchRecordingSummary(current!)).toMatchObject({
      tab_count: 1,
      event_count: 1,
      dropped_steps: 0,
      dropped_events: 0
    });
    expect(watchRecordingSummary(session).approximate_bytes).toBeGreaterThan(0);
  });
});
