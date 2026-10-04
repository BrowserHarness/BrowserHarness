import { describe, expect, it } from "vitest";
import { classifyTaskIntent } from "./intent";

describe("classifyTaskIntent", () => {
  it.each([
    "hi how are you",
    "write a 30 sec video script about ai and its future",
    "explain quantum computing",
    "brainstorm five startup names"
  ])("routes direct chat: %s", (prompt) => {
    expect(classifyTaskIntent(prompt)).toBe("chat");
  });

  it.each([
    "summarize this page",
    "click the pricing link",
    "fill this form",
    'Write "BrowserHarness test" at the current cursor position',
    "search this site for pricing",
    "open the first result in a new tab",
    "go to https://example.com"
  ])("routes browser work: %s", (prompt) => {
    expect(classifyTaskIntent(prompt)).toBe("browser");
  });
});
