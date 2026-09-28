import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cdpCommand: vi.fn(),
  backendNodeForRef: vi.fn()
}));

vi.mock("./cdp-manager", () => ({
  cdpCommand: mocks.cdpCommand
}));

vi.mock("./cdp-semantic", () => ({
  backendNodeForRef: mocks.backendNodeForRef
}));

import { captureCdpScreenshot } from "./cdp-screenshot";

describe("CDP screenshots", () => {
  beforeEach(() => {
    mocks.cdpCommand.mockReset();
    mocks.backendNodeForRef.mockReset();
  });

  it("captures a background-safe viewport screenshot through CDP", async () => {
    mocks.cdpCommand.mockResolvedValue({
      data: "png-data"
    });

    await expect(
      captureCdpScreenshot(7)
    ).resolves.toEqual({
      data_url: "data:image/png;base64,png-data",
      mode: "viewport"
    });

    expect(mocks.cdpCommand).toHaveBeenCalledWith(
      7,
      "Page.captureScreenshot",
      {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false
      }
    );
  });

  it("clips a screenshot to a fresh semantic element ref", async () => {
    mocks.backendNodeForRef.mockReturnValue(301);
    mocks.cdpCommand.mockImplementation(async (_tab, method) => {
      if (method === "DOM.getBoxModel") {
        return {
          model: {
            content: [10, 20, 110, 20, 110, 70, 10, 70]
          }
        };
      }
      if (method === "Page.captureScreenshot") {
        return { data: "element-png" };
      }
      return {};
    });

    const result = await captureCdpScreenshot(8, {
      element_id: "@e4"
    });

    expect(result.mode).toBe("element");
    expect(mocks.backendNodeForRef).toHaveBeenCalledWith(
      8,
      "@e4"
    );
    expect(mocks.cdpCommand).toHaveBeenCalledWith(
      8,
      "Page.captureScreenshot",
      expect.objectContaining({
        captureBeyondViewport: true,
        clip: {
          x: 10,
          y: 20,
          width: 100,
          height: 50,
          scale: 1
        }
      })
    );
  });

  it("captures full-page dimensions from layout metrics", async () => {
    mocks.cdpCommand.mockImplementation(async (_tab, method) => {
      if (method === "Page.getLayoutMetrics") {
        return {
          cssContentSize: {
            width: 1280,
            height: 4200
          }
        };
      }
      if (method === "Page.captureScreenshot") {
        return { data: "full-png" };
      }
      return {};
    });

    const result = await captureCdpScreenshot(9, {
      full_page: true
    });

    expect(result).toEqual({
      data_url: "data:image/png;base64,full-png",
      mode: "full-page"
    });
    expect(mocks.cdpCommand).toHaveBeenCalledWith(
      9,
      "Page.captureScreenshot",
      expect.objectContaining({
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: 0,
          width: 1280,
          height: 4200,
          scale: 1
        }
      })
    );
  });
});
