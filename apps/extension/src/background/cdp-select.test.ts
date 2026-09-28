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

import { selectOptions } from "./cdp-select";

describe("CDP select option", () => {
  beforeEach(() => {
    mocks.cdpCommand.mockReset();
    mocks.backendNodeForRef.mockReset();
    mocks.backendNodeForRef.mockReturnValue(42);
  });

  it("selects a value through a fresh semantic ref and dispatches page events", async () => {
    mocks.cdpCommand.mockImplementation(async (_tab, method) => {
      if (method === "DOM.resolveNode") {
        return { object: { objectId: "select-1" } };
      }
      if (method === "Runtime.callFunctionOn") {
        return {
          result: {
            value: ["IN"]
          }
        };
      }
      return {};
    });

    await expect(
      selectOptions(7, "@e3", ["IN"])
    ).resolves.toEqual({
      selected: ["IN"]
    });

    expect(mocks.backendNodeForRef).toHaveBeenCalledWith(
      7,
      "@e3"
    );
    expect(mocks.cdpCommand).toHaveBeenCalledWith(
      7,
      "Runtime.callFunctionOn",
      expect.objectContaining({
        objectId: "select-1",
        arguments: [{ value: ["IN"] }],
        returnByValue: true,
        userGesture: true
      })
    );
  });

  it("surfaces page-side select failures", async () => {
    mocks.cdpCommand.mockImplementation(async (_tab, method) => {
      if (method === "DOM.resolveNode") {
        return { object: { objectId: "not-select" } };
      }
      if (method === "Runtime.callFunctionOn") {
        return {
          exceptionDetails: {
            exception: {
              description: "Error: Target is not a select element"
            }
          }
        };
      }
      return {};
    });

    await expect(
      selectOptions(7, "@e2", ["US"])
    ).rejects.toThrow("not a select");
  });

  it("rejects empty option requests before browser mutation", async () => {
    await expect(
      selectOptions(7, "@e1", [])
    ).rejects.toThrow("at least one value");
    expect(mocks.cdpCommand).not.toHaveBeenCalled();
  });
});
