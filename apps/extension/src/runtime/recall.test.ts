import { describe, expect, it } from "vitest";
import type { TaskHistoryEntry } from "./history";
import { looksBack, recallAnswer, recallFor, recallHistory, recallPrompt, recallScore } from "./recall";

const now = Date.parse("2026-10-06T12:00:00Z");
const entry = (task: string, result: string, daysAgo: number, url?: string): TaskHistoryEntry => ({
  id: task,
  task,
  result,
  timestamp: new Date(now - daysAgo * 86_400_000).toISOString(),
  ...(url ? { url } : {})
});

const history = [
  entry("compare electric kettles under 2000 on amazon", "The Philips HD9306 at ₹1,599 is the cheapest of the three.", 6, "https://amazon.in/s?k=kettle"),
  entry("find flights from Pune to Delhi next Friday", "IndiGo 6E-123 at 07:10 is the cheapest.", 2),
  entry("write a poem about rain", "Rain on the roof…", 1)
];

describe("recall", () => {
  it("spots requests that refer back", () => {
    expect(looksBack("what did I find last week about kettles?")).toBe(true);
    expect(looksBack("book the same flight as before")).toBe(true);
    expect(looksBack("find kettles under 2000")).toBe(false);
  });

  it("ranks past conversations by what they share with the request", () => {
    expect(recallScore(history[0], "which kettle did I pick last week", now)).toBeGreaterThan(0.3);
    expect(recallScore(history[2], "which kettle did I pick last week", now)).toBe(0);
    expect(recallHistory(history, "kettle prices", { now }).map((item) => item.id)).toEqual([history[0].id]);
  });

  it("adds history only when the request looks back or nearly repeats earlier work", () => {
    expect(recallFor(history, "what did I find about kettles last week?", now).map((item) => item.id)).toEqual([history[0].id]);
    expect(recallFor(history, "find me a kettle", now)).toEqual([]);
    expect(recallFor(history, "find flights from Pune to Delhi", now).map((item) => item.id)).toEqual([history[1].id]);
  });

  it("writes a compact context block and a plain /recall answer", () => {
    const block = recallPrompt([history[0]]);
    expect(block).toContain("FROM OUR PAST CONVERSATIONS");
    expect(block).toContain(`- ${history[0].timestamp.slice(0, 10)}: I asked “compare electric kettles under 2000 on amazon” → The Philips HD9306`);
    expect(block).toContain("(https://amazon.in/s?k=kettle)");
    expect(recallPrompt([])).toBe("");
    expect(recallAnswer(history, "kettles")).toContain("From your past conversations about “kettles”:");
    expect(recallAnswer(history, "submarines")).toContain("I found nothing");
    expect(recallAnswer(history, " ")).toContain("/recall kettle prices");
  });
});
