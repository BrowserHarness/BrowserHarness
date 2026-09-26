import { describe, expect, it } from "vitest";
import {
  MAX_INTERACTIVE_ELEMENTS,
  MAX_OBSERVATION_TEXT,
  compactVisibleText
} from "./observation";

describe("observation limits", () => {
  it("normalizes whitespace and caps visible text", () => {
    const raw = ("hello   world\n".repeat(1000));
    const compact = compactVisibleText(raw);
    expect(compact.length).toBeLessThanOrEqual(MAX_OBSERVATION_TEXT);
    expect(compact).not.toContain("\n");
    expect(compact).not.toContain("  ");
  });

  it("keeps the interactive-element cap intentionally bounded", () => {
    expect(MAX_INTERACTIVE_ELEMENTS).toBe(250);
  });
});
