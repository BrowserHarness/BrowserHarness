import { describe, expect, it } from "vitest";
import {
  createLoopGuard,
  registerDecision
} from "./loop-guard";

describe("loop guard", () => {
  it("blocks the third identical browser action", () => {
    const state = createLoopGuard();
    const decision = {
      kind: "tool" as const,
      tool: "click" as const,
      input: { element_id: "bc-1" },
      note: "click"
    };

    expect(registerDecision(state, decision).ok).toBe(true);
    expect(registerDecision(state, decision).ok).toBe(true);
    expect(registerDecision(state, decision).ok).toBe(false);
  });

  it("allows varied actions", () => {
    const state = createLoopGuard();
    expect(
      registerDecision(state, {
        kind: "tool",
        tool: "click",
        input: { element_id: "bc-1" },
        note: "one"
      }).ok
    ).toBe(true);
    expect(
      registerDecision(state, {
        kind: "tool",
        tool: "click",
        input: { element_id: "bc-2" },
        note: "two"
      }).ok
    ).toBe(true);
  });
});
