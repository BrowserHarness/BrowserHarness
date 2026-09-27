import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWatchRecording: vi.fn(),
  appendWatchEvent: vi.fn(),
  trackWatchTab: vi.fn(),
  markWatchTabClosed: vi.fn()
}));

vi.mock("./watch-recording", () => ({
  getWatchRecording: mocks.getWatchRecording,
  appendWatchEvent: mocks.appendWatchEvent,
  trackWatchTab: mocks.trackWatchTab,
  markWatchTabClosed: mocks.markWatchTabClosed
}));

import { createWatchBrowserEventHandlers } from "./watch-browser-events";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  mocks.getWatchRecording.mockReset();
  mocks.appendWatchEvent.mockReset();
  mocks.trackWatchTab.mockReset();
  mocks.markWatchTabClosed.mockReset();

  mocks.getWatchRecording.mockResolvedValue({
    id: "recording-1",
    started_at: "2026-09-27T00:00:00.000Z",
    root_tab_id: 7,
    current_tab_id: 7,
    start_url: "https://example.com",
    tab_ids: [7, 8],
    steps: [],
    events: [],
    approximate_bytes: 0,
    dropped_steps: 0,
    dropped_events: 0
  });
  mocks.appendWatchEvent.mockResolvedValue({});
  mocks.trackWatchTab.mockResolvedValue({});
  mocks.markWatchTabClosed.mockResolvedValue({});

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      tabs: {
        get: vi.fn(async (tabId: number) => ({
          id: tabId,
          windowId: 3,
          url: `https://example.com/tab-${tabId}`,
          title: `Tab ${tabId}`
        }))
      }
    }
  });
});

describe("Watch Me browser event handlers", () => {
  it("records only top-frame navigation for tracked tabs", async () => {
    const armWatchTab = vi.fn();
    const handlers = createWatchBrowserEventHandlers({
      armWatchTab
    });

    handlers.onCommitted({
      tabId: 7,
      frameId: 0,
      timeStamp: 1,
      url: "https://example.com/next",
      transitionType: "link",
      transitionQualifiers: []
    });
    await tick();

    expect(mocks.appendWatchEvent).toHaveBeenCalledWith({
      type: "navigation",
      tab_id: 7,
      url: "https://example.com/next",
      transition_type: "link",
      transition_qualifiers: []
    });

    mocks.appendWatchEvent.mockClear();

    handlers.onCommitted({
      tabId: 7,
      frameId: 2,
      timeStamp: 2,
      url: "https://frame.example.com",
      transitionType: "auto_subframe",
      transitionQualifiers: []
    });
    await tick();

    expect(mocks.appendWatchEvent).not.toHaveBeenCalled();
  });

  it("automatically re-arms a tracked tab after top-frame completion", async () => {
    const armWatchTab = vi.fn(async () => undefined);
    const handlers = createWatchBrowserEventHandlers({
      armWatchTab
    });

    handlers.onCompleted({
      tabId: 8,
      frameId: 0,
      timeStamp: 3,
      url: "https://example.com/loaded",
      processId: 1
    });
    await tick();

    expect(armWatchTab).toHaveBeenCalledWith(8);
  });

  it("adopts a new tab opened by a recorded tab", async () => {
    const handlers = createWatchBrowserEventHandlers({
      armWatchTab: vi.fn()
    });

    handlers.onCreated({
      id: 9,
      openerTabId: 7,
      windowId: 3,
      index: 2,
      active: false,
      pinned: false,
      highlighted: false,
      incognito: false,
      selected: false,
      discarded: false,
      frozen: false,
      autoDiscardable: true,
      groupId: -1,
      url: "https://example.org",
      title: "Example Org"
    });
    await tick();

    expect(mocks.trackWatchTab).toHaveBeenCalledWith(9);
    expect(mocks.appendWatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "tab_opened",
        tab_id: 9,
        opener_tab_id: 7,
        url: "https://example.org"
      })
    );
  });

  it("records tracked activation and adopts a newly selected tab", async () => {
    const armWatchTab = vi.fn(async () => undefined);
    const handlers = createWatchBrowserEventHandlers({
      armWatchTab
    });

    handlers.onActivated({
      tabId: 8,
      windowId: 3
    });
    await tick();

    expect(mocks.appendWatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "tab_activated",
        tab_id: 8,
        window_id: 3,
        url: "https://example.com/tab-8"
      })
    );
    expect(mocks.trackWatchTab).not.toHaveBeenCalledWith(8);

    mocks.appendWatchEvent.mockClear();
    mocks.trackWatchTab.mockClear();
    armWatchTab.mockClear();

    handlers.onActivated({
      tabId: 99,
      windowId: 3
    });
    await tick();

    expect(mocks.trackWatchTab).toHaveBeenCalledWith(99);
    expect(mocks.appendWatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "tab_activated",
        tab_id: 99,
        window_id: 3,
        url: "https://example.com/tab-99"
      })
    );
    expect(armWatchTab).toHaveBeenCalledWith(99);
  });

  it("records tracked tab closure and updates recording state", async () => {
    const handlers = createWatchBrowserEventHandlers({
      armWatchTab: vi.fn()
    });

    handlers.onRemoved(8);
    await tick();

    expect(mocks.appendWatchEvent).toHaveBeenCalledWith({
      type: "tab_closed",
      tab_id: 8
    });
    expect(mocks.markWatchTabClosed).toHaveBeenCalledWith(8);
  });
});
