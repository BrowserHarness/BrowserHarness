import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitForTabUsable } from "./navigation";

let tab: chrome.tabs.Tab;
let listeners: Array<
  (
    tabId: number,
    changeInfo: chrome.tabs.TabChangeInfo,
    tab: chrome.tabs.Tab
  ) => void
>;

beforeEach(() => {
  listeners = [];
  tab = {
    id: 1,
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
    status: "loading",
    url: "https://example.com",
    title: "Example"
  };

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      tabs: {
        get: vi.fn(async () => ({ ...tab })),
        onUpdated: {
          addListener: vi.fn((listener) => listeners.push(listener)),
          removeListener: vi.fn((listener) => {
            listeners = listeners.filter(
              (candidate) => candidate !== listener
            );
          })
        }
      },
      scripting: {
        executeScript: vi.fn(async () => [
          { frameId: 0, result: tab.status === "complete" ? "complete" : "loading" }
        ])
      }
    }
  });
});

describe("navigation readiness", () => {
  it("returns immediately when the document is already usable", async () => {
    tab.status = "complete";

    const ready = await waitForTabUsable(1, 100);

    expect(ready).toMatchObject({
      tab_id: 1,
      url: "https://example.com",
      status: "complete"
    });
  });

  it("waits for a loading tab to become usable and captures the final URL", async () => {
    const pending = waitForTabUsable(1, 250);

    setTimeout(() => {
      tab = {
        ...tab,
        status: "complete",
        url: "https://example.com/redirected",
        title: "Redirected"
      };
      for (const listener of [...listeners]) {
        listener(
          1,
          {
            status: "complete",
            url: "https://example.com/redirected"
          },
          { ...tab }
        );
      }
    }, 10);

    const ready = await pending;

    expect(ready).toMatchObject({
      tab_id: 1,
      url: "https://example.com/redirected",
      title: "Redirected",
      status: "complete"
    });
  });

  it("fails boundedly when the page never becomes usable", async () => {
    await expect(waitForTabUsable(1, 25)).rejects.toThrow(
      "did not become usable"
    );
  });
});
