import { beforeEach, describe, expect, it } from "vitest";
import {
  aboutMePrompt,
  addFacts,
  factExtractionPrompt,
  factsInMessage,
  factTopic,
  forgetMatching,
  loadAboutMe,
  mightStateFacts,
  parseExtractedFacts,
  updateFact
} from "./about-me";

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
    expect(factsInMessage("Actually I live in Mumbai now")).toEqual(["I live in Mumbai"]);
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

describe("a richer picture of the person", () => {
  it("knows which facts replace each other", async () => {
    expect(factTopic("I live in Pune")).toBe("home");
    expect(factTopic("My name is Priya")).toBe("name");
    expect(factTopic("My favourite airline is IndiGo")).toBe("favourite:airline");
    expect(factTopic("I prefer window seats")).toBeUndefined();
    await addFacts(["I live in Pune", "I prefer window seats"], "learned");
    const added = await addFacts(["I live in Mumbai"], "you");
    expect(added[0].topic).toBe("home");
    expect((await loadAboutMe()).map((fact) => fact.text)).toEqual(["I live in Mumbai", "I prefer window seats"]);
  });

  it("asks the model only when a message may say something lasting, and keeps its answer safe", () => {
    expect(mightStateFacts("I work at Infosys and my kids love cricket")).toBe(true);
    expect(mightStateFacts("summarize this page")).toBe(false);
    const prompt = factExtractionPrompt("I work at Infosys", [
      { id: "1", text: "I live in Pune", source: "you", created_at: "" }
    ]);
    expect(prompt).toContain("Already known (do not repeat): I live in Pune");
    expect(prompt).toContain("MESSAGE:\nI work at Infosys");
    expect(
      parseExtractedFacts('Sure: ["I work at Infosys", "My card is 4111111111111111", "My password is x", 3, "I have two kids."]')
    ).toEqual(["I work at Infosys", "I have two kids"]);
    expect(parseExtractedFacts("nothing here")).toEqual([]);
    expect(parseExtractedFacts("[not json")).toEqual([]);
  });
});
