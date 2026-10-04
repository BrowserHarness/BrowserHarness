import { describe, expect, it } from "vitest";
import { buildPolishPrompt, cleanPolishedPrompt } from "./prompt-polish";

describe("prompt polish", () => {
  it("quotes the draft and forbids new requirements", () => {
    const p = buildPolishPrompt("  find cheap flights  ");
    expect(p).toContain("REQUEST:\nfind cheap flights");
    expect(p).toContain("Do not add new goals");
  });
  it("cleans model wrappers and falls back to the original when empty or huge", () => {
    expect(cleanPolishedPrompt('"Find the cheapest flights."', "x")).toBe("Find the cheapest flights.");
    expect(cleanPolishedPrompt("Rewritten request: Do it", "x")).toBe("Do it");
    expect(cleanPolishedPrompt("   ", "orig")).toBe("orig");
    expect(cleanPolishedPrompt("a".repeat(5000), "orig")).toBe("orig");
  });
});
