import { describe, expect, it } from "vitest";
import { buildPolishPrompt, buildQuestionsPrompt, cleanPolishedPrompt, parseQuestions } from "./prompt-polish";

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
  it("asks for a few plain questions, with the page and a matching Skill as context", () => {
    const p = buildQuestionsPrompt("find shoes", { page: { title: "Shoe Shop", url: "https://shoes.example" }, skill: { name: "red-shoes", instructions: "Search red shoes" } });
    expect(p).toContain("Ask up to 4 short questions");
    expect(p).toContain("A good browser task says");
    expect(p).toContain("Shoe Shop — https://shoes.example");
    expect(p).toContain("/red-shoes");
    expect(p).toContain("REQUEST:\nfind shoes");
  });
  it("reads questions from the reply, and ignores anything malformed", () => {
    const reply = 'Sure!\n```json\n{"questions":[{"question":"What size?","choices":["UK 7","UK 8",""]},{"question":""},{"question":"Budget?"}]}\n```';
    expect(parseQuestions(reply)).toEqual([
      { question: "What size?", choices: ["UK 7", "UK 8"] },
      { question: "Budget?", choices: [] }
    ]);
    expect(parseQuestions("no json here")).toEqual([]);
    expect(parseQuestions("{broken")).toEqual([]);
    expect(parseQuestions('{"questions":[' + '{"question":"q"},'.repeat(6) + '{"question":"q"}]}')).toHaveLength(4);
  });
  it("works the person's answers into the rewrite, skipping blank ones", () => {
    const p = buildPolishPrompt("find shoes", [
      { question: "What size?", answer: "UK 8" },
      { question: "Budget?", answer: "  " }
    ]);
    expect(p).toContain("Q: What size?\nA: UK 8");
    expect(p).not.toContain("Budget?");
    expect(p.startsWith("Rewrite the browser-task request below")).toBe(true);
  });
});
