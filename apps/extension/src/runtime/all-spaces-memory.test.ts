// Memory v2, Phase 3: facts and wishes for every Space, beside each Space's own.
import { beforeEach, describe, expect, it } from "vitest";
import {
  addFacts,
  factScopeIn,
  forgetCommand,
  parseForget,
  removeFact,
  loadAboutMe,
  loadGlobalAboutMe,
  moveFact,
  rememberFacts,
  scopedFactsInMessage,
  withoutScopeWords
} from "./about-me";
import {
  loadGlobalInstructions,
  saveGlobalInstructions,
  saveInstructions,
  scopedInstructionsPrompt
} from "./instructions";
import { createSpace, deleteSpace, DEFAULT_SPACE_ID, pinSpace, switchSpace } from "./spaces";
import { userMemoryPrompt } from "./user-memory";

let store: Record<string, unknown>;

beforeEach(() => {
  store = {};
  pinSpace(null);
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          get: async (key: string | string[]) => {
            const keys = Array.isArray(key) ? key : [key];
            return Object.fromEntries(keys.map((name) => [name, structuredClone(store[name])]));
          },
          set: async (value: Record<string, unknown>) => {
            Object.assign(store, structuredClone(value));
          },
          remove: async (keys: string | string[]) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
          }
        }
      }
    }
  });
});

async function work(): Promise<string> {
  const created = await createSpace("Work", { switchTo: false });
  if (!created.ok) throw new Error("space");
  return created.space.id;
}

describe("which level a fact belongs at", () => {
  it("keeps who you are for every Space and everything else in the Space it was said in", () => {
    expect(factScopeIn("My name is Neo")).toBe("global");
    expect(factScopeIn("I like to be called Neo")).toBe("global");
    expect(factScopeIn("I live in Mumbai")).toBe("global");
    expect(factScopeIn("My language is English")).toBe("global");
    // Ambiguous preferences stay in the narrowest level.
    expect(factScopeIn("I prefer short answers")).toBe("space");
    expect(factScopeIn("I work at Infosys")).toBe("space");
    expect(factScopeIn("My currency is INR")).toBe("space");
  });

  it("follows what the person says about where it applies", () => {
    expect(factScopeIn("Keep answers concise", "Across all Spaces, keep answers concise")).toBe("global");
    expect(factScopeIn("I prefer concise answers", "I generally prefer concise answers")).toBe("global");
    expect(factScopeIn("Always use INR", "For this project, always use INR")).toBe("space");
    expect(factScopeIn("My name is Neo", "In this Space my name is Neo")).toBe("space");
    expect(withoutScopeWords("across all Spaces, keep answers concise")).toBe("Keep answers concise");
  });

  it("finds the facts in a message, each at its level", () => {
    expect(scopedFactsInMessage("My name is Priya and I prefer window seats.")).toEqual([
      { text: "My name is Priya", scope: "global" },
      { text: "I prefer window seats", scope: "space" }
    ]);
    expect(scopedFactsInMessage("Across all Spaces, keep answers concise.")).toEqual([{ text: "Keep answers concise", scope: "global" }]);
  });
});

describe("facts for every Space", () => {
  it("scenario 1: a preference said in one Space never leaks into another", async () => {
    const w = await work();
    await rememberFacts(scopedFactsInMessage("I prefer casual writing"), "learned", DEFAULT_SPACE_ID);
    await rememberFacts(scopedFactsInMessage("I prefer formal reports"), "learned", w);
    const personal = await userMemoryPrompt(DEFAULT_SPACE_ID);
    const office = await userMemoryPrompt(w);
    expect(personal).toContain("I prefer casual writing");
    expect(personal).not.toContain("formal reports");
    expect(office).toContain("I prefer formal reports");
    expect(office).not.toContain("casual writing");
    expect(await loadGlobalAboutMe()).toEqual([]);
  });

  it("scenario 2: something said for all Spaces is known in every Space", async () => {
    const w = await work();
    await rememberFacts(scopedFactsInMessage("Across all Spaces, keep answers concise."), "you", w);
    expect(await userMemoryPrompt(DEFAULT_SPACE_ID)).toContain("Keep answers concise");
    expect(await userMemoryPrompt(w)).toContain("Keep answers concise");
  });

  it("lets a Space's own fact win over the one for every Space on the same topic", async () => {
    const w = await work();
    await addFacts(["My currency is USD"], "you", undefined, "global");
    await addFacts(["My currency is INR"], "you", w);
    const office = await userMemoryPrompt(w);
    expect(office).toContain("My currency is INR");
    expect(office).not.toContain("USD");
    expect(await userMemoryPrompt(DEFAULT_SPACE_ID)).toContain("My currency is USD");
  });

  it("a new home for every Space replaces the old one in the Space where it was said", async () => {
    await addFacts(["I live in Pune"], "you", DEFAULT_SPACE_ID); // saved before Phase 3
    await rememberFacts(scopedFactsInMessage("I live in Mumbai now"), "learned", DEFAULT_SPACE_ID);
    const prompt = await userMemoryPrompt(DEFAULT_SPACE_ID);
    expect(prompt).toContain("I live in Mumbai");
    expect(prompt).not.toContain("Pune");
  });

  it("moves a fact between this Space and every Space", async () => {
    const w = await work();
    const [fact] = await addFacts(["I prefer aisle seats"], "you", w);
    pinSpace(w);
    await moveFact(fact.id, "global");
    expect(await loadAboutMe(w)).toEqual([]);
    expect((await loadGlobalAboutMe()).map((item) => item.text)).toEqual(["I prefer aisle seats"]);
    expect(await userMemoryPrompt(DEFAULT_SPACE_ID)).toContain("I prefer aisle seats");
    const [shared] = await loadGlobalAboutMe();
    await moveFact(shared.id, "space");
    expect(await loadGlobalAboutMe()).toEqual([]);
    expect((await loadAboutMe(w)).map((item) => item.text)).toEqual(["I prefer aisle seats"]);
    expect(await userMemoryPrompt(DEFAULT_SPACE_ID)).not.toContain("aisle");
  });

  it("a normal /forget never removes a fact used in every Space, and says how to", async () => {
    const w = await work();
    await addFacts(["I visit Pune often"], "you", undefined, "global");
    const answer = await forgetCommand("pune", w);
    expect(answer).toContain("remembered in every Space");
    expect(answer).toContain("/forget everywhere pune");
    expect((await loadGlobalAboutMe()).map((item) => item.text)).toEqual(["I visit Pune often"]);
  });

  it("a normal /forget never changes another Space", async () => {
    const w = await work();
    await addFacts(["I like Pune cafes"], "you", w);
    await addFacts(["Pune office address is on file"], "you", DEFAULT_SPACE_ID);
    expect(await forgetCommand("pune", w)).toBe("Forgot 1 fact about “pune”.");
    expect(await loadAboutMe(w)).toEqual([]);
    expect((await loadAboutMe(DEFAULT_SPACE_ID)).map((item) => item.text)).toEqual(["Pune office address is on file"]);
  });

  it("/forget everywhere removes the fact used in every Space, and nothing in any Space", async () => {
    const w = await work();
    await addFacts(["I visit Pune often"], "you", undefined, "global");
    await addFacts(["I like Pune cafes"], "you", w);
    expect(await forgetCommand("everywhere pune", w)).toBe("Forgot 1 fact about “pune” in every Space.");
    expect(await loadGlobalAboutMe()).toEqual([]);
    expect((await loadAboutMe(w)).map((item) => item.text)).toEqual(["I like Pune cafes"]);
    await addFacts(["I visit Pune often"], "you", undefined, "global");
    expect(await forgetCommand("across all Spaces pune", w)).toContain("in every Space");
    expect(await loadGlobalAboutMe()).toEqual([]);
    expect(parseForget("from all my spaces: tea")).toEqual({ words: "tea", scope: "global" });
    expect(parseForget("tea everywhere")).toEqual({ words: "tea everywhere", scope: "space" });
  });

  it("with the same topic here and in every Space, a normal /forget removes only this Space's", async () => {
    const w = await work();
    await addFacts(["My currency is USD"], "you", undefined, "global");
    await addFacts(["My currency is INR"], "you", w);
    expect(await forgetCommand("currency", w)).toBe("Forgot 1 fact about “currency”.");
    expect(await loadAboutMe(w)).toEqual([]);
    expect((await loadGlobalAboutMe()).map((item) => item.text)).toEqual(["My currency is USD"]);
    expect(await userMemoryPrompt(w)).toContain("My currency is USD");
  });

  it("the About you screen's delete buttons remove one fact at the level it is shown", async () => {
    const w = await work();
    pinSpace(w);
    const [local] = await addFacts(["I prefer aisle seats"], "you", w);
    const [shared] = await addFacts(["I prefer aisle seats on trains"], "you", undefined, "global");
    await removeFact(shared.id, "space"); // wrong level: nothing happens
    expect(await loadGlobalAboutMe()).toHaveLength(1);
    await removeFact(shared.id, "global");
    expect(await loadGlobalAboutMe()).toEqual([]);
    expect((await loadAboutMe(w)).map((item) => item.id)).toEqual([local.id]);
    await removeFact(local.id, "space");
    expect(await loadAboutMe(w)).toEqual([]);
  });

  it("never keeps a secret for every Space", async () => {
    expect(await addFacts(["My password is hunter22"], "you", undefined, "global")).toEqual([]);
    expect(await loadGlobalAboutMe()).toEqual([]);
  });

  it("keeps every Space's facts when a Space is deleted", async () => {
    const w = await work();
    await addFacts(["My name is Neo"], "you", undefined, "global");
    await addFacts(["I work at Infosys"], "you", w);
    await deleteSpace(w);
    expect((await loadGlobalAboutMe()).map((item) => item.text)).toEqual(["My name is Neo"]);
  });
});

describe("wishes for every Space", () => {
  it("keeps this-Space wishes in their Space and every-Space wishes everywhere", async () => {
    const w = await work();
    await switchSpace(w);
    await saveInstructions("Use technical words");
    await switchSpace(DEFAULT_SPACE_ID);
    await saveGlobalInstructions("Prefer Indian sites");
    const office = await userMemoryPrompt(w);
    const personal = await userMemoryPrompt(DEFAULT_SPACE_ID);
    expect(office).toContain("Prefer Indian sites");
    expect(office).toContain("Use technical words");
    expect(personal).toContain("Prefer Indian sites");
    expect(personal).not.toContain("technical words");
  });

  it("says which wishes are whose, and that this Space's win", () => {
    const both = scopedInstructionsPrompt("Answer briefly", "Answer in detail");
    expect(both.indexOf("In every Space:")).toBeLessThan(both.indexOf("Answer briefly"));
    expect(both).toContain("In this Space (these win where the two disagree):\nAnswer in detail");
    // With only one kind, the block reads exactly as before.
    expect(scopedInstructionsPrompt("", "Answer briefly")).not.toContain("In every Space");
    expect(scopedInstructionsPrompt("Answer briefly", "")).toContain("Answer briefly");
    expect(scopedInstructionsPrompt("", "")).toBe("");
  });

  it("refuses a password in the wishes for every Space", async () => {
    expect((await saveGlobalInstructions("My bank password is hunter22")).ok).toBe(false);
    expect(await loadGlobalInstructions()).toBe("");
  });
});

describe("after updating", () => {
  it("keeps facts and wishes saved before Phase 3 working in their Space, and promotes nothing", async () => {
    const w = await work();
    store["browserharness.aboutMe"] = [{ id: "1", text: "I prefer window seats", source: "you", created_at: "2026-10-01T00:00:00.000Z" }];
    store["browserharness.instructions"] = "Show prices in rupees";
    const personal = await userMemoryPrompt(DEFAULT_SPACE_ID);
    expect(personal).toContain("I prefer window seats");
    expect(personal).toContain("Show prices in rupees");
    const office = await userMemoryPrompt(w);
    expect(office).not.toContain("window seats");
    expect(office).not.toContain("rupees");
    expect(await loadGlobalAboutMe()).toEqual([]);
    expect(await loadGlobalInstructions()).toBe("");
  });
});
