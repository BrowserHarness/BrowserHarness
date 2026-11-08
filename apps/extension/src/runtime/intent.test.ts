import { describe, expect, it } from "vitest";
import { classifyTaskIntent } from "./intent";

describe("classifyTaskIntent", () => {
  it.each([
    "hi how are you",
    "write a 30 sec video script about ai and its future",
    "explain quantum computing",
    "brainstorm five startup names",
    "what should I search for when learning python",
    "give me a recipe for dal",
    "make a table comparing cats and dogs",
    "how do I add a column to my spreadsheet"
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
    "visit amazon.in and find a kettle under 2000",
    "extract the prices table",
    "search the tea shop for green tea and add it to the cart",
    "sign me up for the webinar",
    "subscribe me to their newsletter",
    "save these results to a csv"
  ])("routes browser work: %s", (prompt) => {
    expect(classifyTaskIntent(prompt)).toBe("browser");
  });
});

describe("tasks on named sites, shopping and follow-ups", () => {
  it("treats doing something on a known site as a browser task", () => {
    expect(classifyTaskIntent("find an electric kettle under 2000 rupees amazon")).toBe("browser");
    expect(classifyTaskIntent("Follow 20 relevant public accounts from @ritualistic.in's followers")).toBe("browser");
    expect(classifyTaskIntent("buy me a phone charger")).toBe("browser");
    expect(classifyTaskIntent("order 2 packs of coffee")).toBe("browser");
  });

  it("keeps ordinary questions as chat", () => {
    expect(classifyTaskIntent("what is the order of operations in maths?")).toBe("chat");
    expect(classifyTaskIntent("explain how photosynthesis works")).toBe("chat");
    expect(classifyTaskIntent("proceed")).toBe("chat");
  });

  it("carries a browser task on when the next message is a follow-up", () => {
    expect(classifyTaskIntent("proceed", { continuing: true })).toBe("browser");
    expect(classifyTaskIntent("Go ahead and repeat for the other competitors", { continuing: true })).toBe("browser");
    expect(classifyTaskIntent("why is the sky blue?", { continuing: true })).toBe("chat");
  });
});
