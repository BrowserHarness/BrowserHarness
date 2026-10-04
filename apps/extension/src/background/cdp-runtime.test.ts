import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cdpCommand: vi.fn()
}));

vi.mock("./cdp-manager", () => ({
  cdpCommand: mocks.cdpCommand
}));

import {
  backendNodeForRef,
  captureAxSnapshot,
  elementForAxRef,
  findAxElements
} from "./cdp-semantic";
import {
  trustedClick,
  trustedKey,
  trustedType
} from "./cdp-input";

describe("CDP semantic and trusted-input runtime", () => {
  beforeEach(() => {
    mocks.cdpCommand.mockReset();
  });

  it("converts the accessibility tree into stable semantic refs", async () => {
    mocks.cdpCommand.mockResolvedValueOnce({
      nodes: [
        {
          nodeId: "1",
          backendDOMNodeId: 101,
          role: { value: "button" },
          name: { value: "Continue" },
          properties: [
            { name: "focused", value: { value: true } }
          ]
        },
        {
          nodeId: "2",
          backendDOMNodeId: 102,
          role: { value: "textbox" },
          name: { value: "Email" },
          value: { value: "user@example.com" }
        },
        {
          nodeId: "3",
          ignored: true,
          backendDOMNodeId: 103,
          role: { value: "button" },
          name: { value: "Ignored" }
        }
      ]
    });

    const snapshot = await captureAxSnapshot(7);

    expect(snapshot.elements).toEqual([
      expect.objectContaining({
        element_id: "@e1",
        backend_node_id: 101,
        role: "button",
        name: "Continue",
        focused: true
      }),
      expect.objectContaining({
        element_id: "@e2",
        backend_node_id: 102,
        role: "textbox",
        name: "Email",
        value: "user@example.com"
      })
    ]);
    expect(snapshot.text).toContain('@e1 button "Continue"');
    expect(backendNodeForRef(7, "@e2")).toBe(102);
    expect(elementForAxRef(7, "@e1")?.name).toBe("Continue");
  });

  it("finds fresh AX elements by semantic text and role", () => {
    const matches = findAxElements(
      {
        text: "",
        elements: [
          {
            element_id: "@e1",
            backend_node_id: 1,
            role: "button",
            name: "Continue checkout",
            disabled: false,
            focused: false
          },
          {
            element_id: "@e2",
            backend_node_id: 2,
            role: "link",
            name: "Continue reading",
            disabled: false,
            focused: false
          },
          {
            element_id: "@e3",
            backend_node_id: 3,
            role: "button",
            name: "Cancel",
            description: "Return to cart",
            disabled: false,
            focused: false
          }
        ]
      },
      {
        query: "continue",
        role: "button"
      }
    );

    expect(matches.map((item) => item.element_id)).toEqual([
      "@e1"
    ]);
  });

  it("dispatches trusted mouse input at the target box center", async () => {
    mocks.cdpCommand.mockResolvedValueOnce({
      nodes: [
        {
          nodeId: "1",
          backendDOMNodeId: 201,
          role: { value: "button" },
          name: { value: "Open" }
        }
      ]
    });
    await captureAxSnapshot(9);

    mocks.cdpCommand.mockReset();
    mocks.cdpCommand.mockImplementation(async (_tab, method) => {
      if (method === "DOM.getBoxModel") {
        return {
          model: {
            content: [10, 20, 110, 20, 110, 60, 10, 60]
          }
        };
      }
      if (method === "DOM.resolveNode") {
        return {
          object: {
            objectId: "target-1"
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
      return {};
    });

    const result = await trustedClick(9, "@e1");

    expect(result).toEqual({ x: 60, y: 40 });
    expect(mocks.cdpCommand).toHaveBeenCalledWith(
      9,
      "DOM.scrollIntoViewIfNeeded",
      { backendNodeId: 201 }
    );
    expect(mocks.cdpCommand).toHaveBeenCalledWith(
      9,
      "Input.dispatchMouseEvent",
      expect.objectContaining({
        type: "mousePressed",
        x: 60,
        y: 40,
        button: "left"
      })
    );
  });

  it("refuses trusted mouse input when the calculated point is occluded", async () => {
    mocks.cdpCommand.mockResolvedValueOnce({
      nodes: [
        {
          nodeId: "1",
          backendDOMNodeId: 202,
          role: { value: "button" },
          name: { value: "Continue" }
        }
      ]
    });
    await captureAxSnapshot(12);

    mocks.cdpCommand.mockReset();
    mocks.cdpCommand.mockImplementation(async (_tab, method) => {
      if (method === "DOM.getBoxModel") {
        return {
          model: {
            content: [0, 0, 100, 0, 100, 40, 0, 40]
          }
        };
      }
      if (method === "DOM.resolveNode") {
        return {
          object: {
            objectId: "target-2"
          }
        };
      }
      if (method === "Runtime.callFunctionOn") {
        return {
          result: {
            value: false
          }
        };
      }
      return {};
    });

    await expect(
      trustedClick(12, "@e1")
    ).rejects.toThrow("occluded");

    expect(
      mocks.cdpCommand.mock.calls.some(
        ([, method]) => method === "Input.dispatchMouseEvent"
      )
    ).toBe(false);
  });

  it("fails trusted click when CDP input is not delivered to the intended target", async () => {
    mocks.cdpCommand.mockResolvedValueOnce({
      nodes: [
        {
          nodeId: "1",
          backendDOMNodeId: 203,
          role: { value: "button" },
          name: { value: "Continue" }
        }
      ]
    });
    await captureAxSnapshot(13);

    mocks.cdpCommand.mockReset();
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
        return {
          object: {
            objectId: "target-3"
          }
        };
      }
      if (method === "Runtime.callFunctionOn") {
        runtimeCalls += 1;
        return {
          result: {
            value: runtimeCalls < 3
          }
        };
      }
      return {};
    });

    await expect(
      trustedClick(13, "@e1")
    ).rejects.toThrow("not delivered");

    expect(
      mocks.cdpCommand.mock.calls.filter(
        ([, method]) => method === "Input.dispatchMouseEvent"
      )
    ).toHaveLength(3);
  });

  it("uses DOM.focus plus Input.insertText for trusted text", async () => {
    mocks.cdpCommand.mockResolvedValueOnce({
      nodes: [
        {
          nodeId: "1",
          backendDOMNodeId: 301,
          role: { value: "textbox" },
          name: { value: "Message" }
        }
      ]
    });
    await captureAxSnapshot(10);

    mocks.cdpCommand.mockReset();
    mocks.cdpCommand.mockResolvedValue({});

    await expect(
      trustedType(10, "@e1", "BrowserHarness")
    ).resolves.toEqual({ typed: 14 });

    expect(mocks.cdpCommand).toHaveBeenNthCalledWith(
      1,
      10,
      "Emulation.setFocusEmulationEnabled",
      { enabled: true }
    );
    expect(mocks.cdpCommand).toHaveBeenNthCalledWith(
      2,
      10,
      "DOM.focus",
      { backendNodeId: 301 }
    );
    expect(mocks.cdpCommand).toHaveBeenNthCalledWith(
      3,
      10,
      "Input.insertText",
      { text: "BrowserHarness" }
    );
  });

  it("dispatches trusted keyboard down/up events", async () => {
    mocks.cdpCommand.mockResolvedValue({});

    await trustedKey(11, "Enter");

    expect(mocks.cdpCommand).toHaveBeenNthCalledWith(
      1,
      11,
      "Emulation.setFocusEmulationEnabled",
      { enabled: true }
    );
    expect(mocks.cdpCommand).toHaveBeenNthCalledWith(
      2,
      11,
      "Input.dispatchKeyEvent",
      {
        type: "keyDown",
        key: "Enter",
        code: "Enter"
      }
    );
    expect(mocks.cdpCommand).toHaveBeenNthCalledWith(
      3,
      11,
      "Input.dispatchKeyEvent",
      {
        type: "keyUp",
        key: "Enter",
        code: "Enter"
      }
    );
  });
});
