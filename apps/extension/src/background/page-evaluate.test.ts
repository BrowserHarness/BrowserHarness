import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cdpCommand: vi.fn()
}));

vi.mock("./cdp-manager", () => ({
  cdpCommand: mocks.cdpCommand
}));

import { evaluatePageExpression } from "./page-evaluate";

describe("page evaluate", () => {
  beforeEach(() => {
    mocks.cdpCommand.mockReset();
  });

  it("evaluates an expression in page context and returns JSON-safe data", async () => {
    mocks.cdpCommand.mockResolvedValue({
      result: {
        type: "object",
        value: {
          action: "/checkout",
          method: "post"
        }
      }
    });

    await expect(
      evaluatePageExpression(
        4,
        "({action: document.forms[0]?.action, method: document.forms[0]?.method})"
      )
    ).resolves.toEqual({
      type: "object",
      value: {
        action: "/checkout",
        method: "post"
      }
    });

    expect(mocks.cdpCommand).toHaveBeenCalledWith(
      4,
      "Runtime.evaluate",
      expect.objectContaining({
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      })
    );
  });

  it("surfaces page exceptions", async () => {
    mocks.cdpCommand.mockResolvedValue({
      result: {
        type: "object"
      },
      exceptionDetails: {
        text: "Uncaught",
        exception: {
          description: "ReferenceError: missing is not defined"
        }
      }
    });

    await expect(
      evaluatePageExpression(5, "missing.value")
    ).rejects.toThrow("ReferenceError");
  });

  it("rejects oversized results instead of flooding the agent context", async () => {
    mocks.cdpCommand.mockResolvedValue({
      result: {
        type: "string",
        value: "x".repeat(200)
      }
    });

    await expect(
      evaluatePageExpression(6, "document.body.innerText", 50)
    ).rejects.toThrow("exceeded 50 characters");
  });
});
