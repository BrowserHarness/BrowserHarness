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

import { trustedHover } from "./cdp-input";

describe("trusted hover", () => {
  beforeEach(() => {
    mocks.cdpCommand.mockReset();
    mocks.backendNodeForRef.mockReset();
    mocks.backendNodeForRef.mockReturnValue(77);
  });

  it("moves the real pointer and verifies :hover on the intended target", async () => {
    let runtimeCalls = 0;
    mocks.cdpCommand.mockImplementation(async (_tab, method) => {
      if (method === "DOM.getBoxModel") {
        return {
          model: {
            content: [10, 20, 110, 20, 110, 60, 10, 60]
          }
        };
      }
      if (method === "DOM.resolveNode") {
        return { object: { objectId: "hover-1" } };
      }
      if (method === "Runtime.callFunctionOn") {
        runtimeCalls += 1;
        return {
          result: {
            value: true
          }
        };
      }
      return {};
    });

    await expect(
      trustedHover(7, "@e2")
    ).resolves.toEqual({ x: 60, y: 40 });

    expect(mocks.cdpCommand).toHaveBeenCalledWith(
      7,
      "Input.dispatchMouseEvent",
      {
        type: "mouseMoved",
        x: 60,
        y: 40,
        button: "none"
      }
    );
    expect(runtimeCalls).toBe(2);
  });

  it("refuses to hover through an occluding element", async () => {
    mocks.cdpCommand.mockImplementation(async (_tab, method) => {
      if (method === "DOM.getBoxModel") {
        return {
          model: {
            content: [0, 0, 100, 0, 100, 40, 0, 40]
          }
        };
      }
      if (method === "DOM.resolveNode") {
        return { object: { objectId: "hover-2" } };
      }
      if (method === "Runtime.callFunctionOn") {
        return { result: { value: false } };
      }
      return {};
    });

    await expect(
      trustedHover(7, "@e2")
    ).rejects.toThrow("occluded");

    expect(
      mocks.cdpCommand.mock.calls.some(
        ([, method]) => method === "Input.dispatchMouseEvent"
      )
    ).toBe(false);
  });

  it("fails when Chrome moves the pointer but the target is not hovered", async () => {
    let runtimeCalls = 0;
    mocks.cdpCommand.mockImplementation(async (_tab, method) => {
      if (method === "DOM.getBoxModel") {
        return {
          model: {
            content: [0, 0, 100, 0, 100, 40, 0, 40]
          }
        };
      }
      if (method === "DOM.resolveNode") {
        return { object: { objectId: "hover-3" } };
      }
      if (method === "Runtime.callFunctionOn") {
        runtimeCalls += 1;
        return {
          result: {
            value: runtimeCalls === 1
          }
        };
      }
      return {};
    });

    await expect(
      trustedHover(7, "@e2")
    ).rejects.toThrow("not delivered");
  });
});
