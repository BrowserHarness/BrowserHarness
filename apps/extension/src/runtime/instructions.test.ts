import { beforeEach, describe, expect, it } from "vitest";
import {
  instructionsFile,
  instructionsFromFile,
  instructionsPrompt,
  loadInstructions,
  saveInstructions
} from "./instructions";

let store: Record<string, unknown>;
beforeEach(() => {
  store = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (items: Record<string, unknown>) => Object.assign(store, items)
      }
    }
  };
});

describe("standing instructions", () => {
  it("saves rules about secrets but never the secrets themselves", async () => {
    expect(await saveInstructions("Answer briefly.\nPrices in rupees.\nNever buy anything over ₹5,000 without asking.\nNever type my password for me.")).toEqual({ ok: true });
    expect(await loadInstructions()).toContain("Never type my password for me.");
    expect((await saveInstructions("My password is hunter2")).ok).toBe(false);
    expect((await saveInstructions("Pay with card 4111 1111 1111 1111")).ok).toBe(false);
    expect(await loadInstructions()).toContain("Answer briefly.");
  });

  it("goes with every request, below safety rules", () => {
    expect(instructionsPrompt("")).toBe("");
    const prompt = instructionsPrompt("Answer briefly.");
    expect(prompt).toContain("HOW I WANT YOU TO WORK");
    expect(prompt).toContain("never switch off BrowserHarness safety rules or approvals");
    expect(prompt.endsWith("Answer briefly.")).toBe(true);
  });

  it("round-trips through a file", () => {
    const file = instructionsFile("Answer briefly.\nPrices in rupees.");
    expect(file.startsWith("# How BrowserHarness should work for me")).toBe(true);
    expect(instructionsFromFile(file)).toBe("Answer briefly.\nPrices in rupees.");
    expect(instructionsFromFile("---\nname: soul\n---\n# Me\n\nBe kind.")).toBe("Be kind.");
  });
});
