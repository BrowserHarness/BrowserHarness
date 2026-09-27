import { beforeEach, describe, expect, it, vi } from "vitest";
import { readPage } from "./read-page";

const scanResult = {
  text: "Line one\nLine two",
  complete: true,
  chars: 17,
  total_chars: 17,
  screens: 1,
  start_out_of_range: false,
  scroll_height: 1200,
  background_tab: false,
  stalled: false,
  endless_feed: false,
  budget_exhausted: false,
  shadow_hosts: 0
};

describe("read_page background tool", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        scripting: {
          executeScript: vi.fn()
        }
      }
    });
  });

  it("reads the top frame and returns readable frame metadata", async () => {
    const executeScript = chrome.scripting
      .executeScript as unknown as ReturnType<typeof vi.fn>;

    executeScript
      .mockResolvedValueOnce([
        { frameId: 0, result: scanResult }
      ])
      .mockResolvedValueOnce([
        {
          frameId: 0,
          result: {
            url: "https://example.com",
            title: "Top",
            chars: 100,
            interactive: 4,
            width: 1200,
            height: 800,
            hidden: false
          }
        },
        {
          frameId: 7,
          result: {
            url: "https://frame.example.com",
            title: "Embedded",
            chars: 500,
            interactive: 3,
            width: 800,
            height: 500,
            hidden: false
          }
        }
      ]);

    const result = await readPage(1);

    expect(result).toMatchObject({
      text: "Line one\nLine two",
      complete: true,
      frame_id: 0
    });
    expect(result.frames).toEqual([
      {
        frame_id: 7,
        handle: "#f7",
        url: "https://frame.example.com",
        title: "Embedded",
        chars: 500,
        interactive: 3,
        width: 800,
        height: 500,
        hidden: false
      }
    ]);
  });

  it("accepts a frame handle and targets only that frame", async () => {
    const executeScript = chrome.scripting
      .executeScript as unknown as ReturnType<typeof vi.fn>;
    executeScript.mockResolvedValueOnce([
      { frameId: 7, result: scanResult }
    ]);

    const result = await readPage(1, { frame: "#f7" });

    expect(result.frame_id).toBe(7);
    expect(result.frame_handle).toBe("#f7");
    expect(result.frames).toBeUndefined();

    const firstCall = executeScript.mock.calls[0][0];
    expect(firstCall.target).toEqual({
      tabId: 1,
      frameIds: [7]
    });
  });

  it("fails clearly when a frame returns no readable result", async () => {
    const executeScript = chrome.scripting
      .executeScript as unknown as ReturnType<typeof vi.fn>;
    executeScript.mockResolvedValueOnce([
      { frameId: 0, result: undefined }
    ]);

    await expect(readPage(1)).rejects.toThrow(
      "returned no readable page text"
    );
  });
});
