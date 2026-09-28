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

import { trustedDrag } from "./cdp-input";

describe("trusted drag", () => {
  beforeEach(() => {
    mocks.cdpCommand.mockReset();
    mocks.backendNodeForRef.mockReset();
    mocks.backendNodeForRef.mockImplementation((_tab, ref) =>
      ref === "@source" ? 101 : 202
    );
  });

  it("drags between fresh semantic refs with a held-button path and verifies delivery", async () => {
    let runtimeChecks = 0;
    mocks.cdpCommand.mockImplementation(async (_tab, method, params) => {
      if (method === "DOM.getBoxModel") {
        const backendNodeId = params?.backendNodeId;
        return backendNodeId === 101
          ? {
              model: {
                content: [0, 0, 40, 0, 40, 40, 0, 40]
              }
            }
          : {
              model: {
                content: [100, 100, 160, 100, 160, 160, 100, 160]
              }
            };
      }
      if (method === "DOM.resolveNode") {
        return {
          object: {
            objectId:
              params?.backendNodeId === 101 ? "source-1" : "target-1"
          }
        };
      }
      if (method === "Runtime.callFunctionOn") {
        runtimeChecks += 1;
        return {
          result: {
            value: true
          }
        };
      }
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: true
          }
        };
      }
      return {};
    });

    const result = await trustedDrag(
      9,
      "@source",
      "@target",
      4
    );

    expect(result).toEqual({
      source: { x: 20, y: 20 },
      target: { x: 130, y: 130 },
      steps: 4
    });

    const dispatches = mocks.cdpCommand.mock.calls.filter(
      ([, method]) => method === "Input.dispatchMouseEvent"
    );
    expect(dispatches).toHaveLength(7);
    expect(dispatches[1][2]).toMatchObject({
      type: "mousePressed",
      x: 20,
      y: 20,
      button: "left",
      buttons: 1
    });
    expect(dispatches.at(-1)?.[2]).toMatchObject({
      type: "mouseReleased",
      x: 130,
      y: 130,
      button: "left",
      buttons: 0
    });
    expect(
      dispatches.filter(([, , params]) => params.type === "mouseMoved")
        .slice(1)
        .every(([, , params]) => params.buttons === 1)
    ).toBe(true);
    expect(runtimeChecks).toBe(3);
  });

  it("refuses to start when either drag endpoint is occluded", async () => {
    let hitTests = 0;
    mocks.cdpCommand.mockImplementation(async (_tab, method, params) => {
      if (method === "DOM.getBoxModel") {
        const backendNodeId = params?.backendNodeId;
        return backendNodeId === 101
          ? {
              model: {
                content: [0, 0, 40, 0, 40, 40, 0, 40]
              }
            }
          : {
              model: {
                content: [100, 100, 160, 100, 160, 160, 100, 160]
              }
            };
      }
      if (method === "DOM.resolveNode") {
        return {
          object: {
            objectId:
              params?.backendNodeId === 101 ? "source-2" : "target-2"
          }
        };
      }
      if (method === "Runtime.callFunctionOn") {
        hitTests += 1;
        return {
          result: {
            value: hitTests === 1
          }
        };
      }
      return {};
    });

    await expect(
      trustedDrag(10, "@source", "@target")
    ).rejects.toThrow("Drag target is occluded");

    expect(
      mocks.cdpCommand.mock.calls.some(
        ([, method]) => method === "Input.dispatchMouseEvent"
      )
    ).toBe(false);
  });

  it("fails when the page does not receive both ends of the drag", async () => {
    mocks.cdpCommand.mockImplementation(async (_tab, method, params) => {
      if (method === "DOM.getBoxModel") {
        const backendNodeId = params?.backendNodeId;
        return backendNodeId === 101
          ? {
              model: {
                content: [0, 0, 40, 0, 40, 40, 0, 40]
              }
            }
          : {
              model: {
                content: [100, 100, 160, 100, 160, 160, 100, 160]
              }
            };
      }
      if (method === "DOM.resolveNode") {
        return {
          object: {
            objectId:
              params?.backendNodeId === 101 ? "source-3" : "target-3"
          }
        };
      }
      if (method === "Runtime.callFunctionOn") {
        return {
          result: {
            value: true
          }
        };
      }
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: false
          }
        };
      }
      return {};
    });

    await expect(
      trustedDrag(11, "@source", "@target", 3)
    ).rejects.toThrow("not delivered");
  });
});
