import { describe, expect, it } from "vitest";
import { classifyTaskIntent } from "./intent";

describe("classifyTaskIntent", () => {
  it.each([
    "hi how are you",
    "write a 30 sec video script about ai and its future",
    "explain quantum computing",
    "brainstorm five startup names",
    "what should I search for when learning python",
    "give me a recipe for dal"
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
    "go to https://example.com",
    "go to the search page and search for red shoes",
    "open youtube and play lofi music",
    "find the cheapest flight on google flights",
    "check my inbox on gmail",
    "visit amazon.in and find a kettle under 2000"
  ])("routes browser work: %s", (prompt) => {
    expect(classifyTaskIntent(prompt)).toBe("browser");
  });
});
