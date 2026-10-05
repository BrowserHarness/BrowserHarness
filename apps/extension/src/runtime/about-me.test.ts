import { beforeEach, describe, expect, it } from "vitest";
import { aboutMePrompt, addFacts, factsInMessage, forgetMatching, loadAboutMe, updateFact } from "./about-me";

let store: Record<string, unknown>;
beforeEach(() => {
  store = {};
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: store[key] }),
          set: async (value: Record<string, unknown>) => {
            Object.assign(store, value);
          },
          remove: async (key: string) => {
            delete store[key];
          }
        }
      }
    }
  });
});

describe("about me", () => {
  it("picks up plain statements about the person", () => {
    expect(factsInMessage("My name is Priya and I live in Pune. Find me a flight to Delhi, I prefer window seats.")).toEqual([
      "My name is Priya",
      "I live in Pune",
      "I prefer window seats"
    ]);
    expect(factsInMessage("Remember that my budget is under 5000 rupees")).toContain("my budget is under 5000 rupees");
    expect(factsInMessage("remember to click the blue button")).toEqual([]);
    expect(factsInMessage("summarize this page")).toEqual([]);
  });

  it("never keeps secrets or long numbers", () => {
    expect(factsInMessage("remember that my password is hunter2")).toEqual([]);
    expect(factsInMessage("remember that my card is 4111111111111111")).toEqual([]);
  });

  it("stores, dedupes, edits and forgets facts", async () => {
    await addFacts(["I live in Pune", "i live in pune", "Vegetarian"], "you");
    const facts = await loadAboutMe();
    expect(facts.map((fact) => fact.text)).toEqual(["I live in Pune", "Vegetarian"]);
    expect(await updateFact(facts[1].id, "My PIN is 1234")).toBe(false);
    expect(await updateFact(facts[1].id, "Vegetarian, no eggs")).toBe(true);
    expect(await forgetMatching("pune")).toBe(1);
    const left = await loadAboutMe();
    expect(left.map((fact) => fact.text)).toEqual(["Vegetarian, no eggs"]);
    expect(aboutMePrompt(left)).toContain("- Vegetarian, no eggs");
    expect(aboutMePrompt([])).toBe("");
  });
});
