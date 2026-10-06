import { beforeEach, describe, expect, it } from "vitest";
import {
  activeSpaceId,
  backupSpace,
  createSpace,
  DEFAULT_SPACE_ID,
  deleteSpace,
  isKeyFor,
  keyForSpace,
  loadSpaces,
  parseSpaceBackup,
  pinSpace,
  renameSpace,
  restoreSpace,
  switchSpace
} from "./spaces";
import { addFacts, loadAboutMe } from "./about-me";
import { loadInstructions, saveInstructions } from "./instructions";
import { loadTaskHistory, saveTaskHistoryEntry } from "./history";
import { loadChats, saveChatMessages } from "./chats";

let store: Record<string, unknown>;
beforeEach(() => {
  store = {};
  pinSpace(null);
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: store[key] }),
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

const say = (text: string) => [{ id: crypto.randomUUID(), role: "user" as const, text }];

describe("spaces", () => {
  it("starts with one Space that uses the old storage keys", async () => {
    const { spaces, active } = await loadSpaces();
    expect(spaces.map((space) => space.name)).toEqual(["Personal"]);
    expect(active.id).toBe(DEFAULT_SPACE_ID);
    expect(keyForSpace("browserharness.aboutMe", DEFAULT_SPACE_ID)).toBe("browserharness.aboutMe");
    await addFacts(["I live in Pune"], "you");
    expect(store["browserharness.aboutMe"]).toHaveLength(1);
  });

  it("keeps facts, wishes, history and chats apart in each Space", async () => {
    await addFacts(["I live in Pune"], "you");
    await saveInstructions("Answer briefly");
    await saveTaskHistoryEntry({ task: "home task", result: "done" });
    await saveChatMessages("c1", say("home chat"));

    const work = await createSpace("Work");
    expect(work.ok).toBe(true);
    expect(await activeSpaceId()).not.toBe(DEFAULT_SPACE_ID);
    expect(await loadAboutMe()).toEqual([]);
    expect(await loadInstructions()).toBe("");
    expect(await loadTaskHistory()).toEqual([]);
    expect(await loadChats()).toEqual([]);

    await addFacts(["I work at Infosys"], "you");
    await saveChatMessages("c2", say("work chat"));
    expect((await loadAboutMe()).map((fact) => fact.text)).toEqual(["I work at Infosys"]);

    await switchSpace(DEFAULT_SPACE_ID);
    expect((await loadAboutMe()).map((fact) => fact.text)).toEqual(["I live in Pune"]);
    expect((await loadChats()).map((chat) => chat.title)).toEqual(["home chat"]);
    expect(await loadInstructions()).toBe("Answer briefly");
  });

  it("refuses empty and duplicate names", async () => {
    expect(await createSpace("  ")).toMatchObject({ ok: false });
    expect(await createSpace("personal")).toMatchObject({ ok: false });
    const work = await createSpace("Work");
    if (!work.ok) throw new Error("not created");
    expect(await renameSpace(work.space.id, "Personal")).toMatchObject({ ok: false });
    expect(await renameSpace(work.space.id, "Office")).toMatchObject({ ok: true });
    expect((await loadSpaces()).spaces.map((space) => space.name)).toEqual(["Personal", "Office"]);
  });

  it("a scheduled run uses the Space it was pinned to", async () => {
    const work = await createSpace("Work", { switchTo: false });
    if (!work.ok) throw new Error("not created");
    pinSpace(work.space.id);
    await addFacts(["I work at Infosys"], "you");
    pinSpace(null);
    expect(await loadAboutMe()).toEqual([]);
    expect(store[keyForSpace("browserharness.aboutMe", work.space.id)]).toHaveLength(1);
  });

  it("deleting a Space removes everything it kept and goes back to the first Space", async () => {
    const work = await createSpace("Work");
    if (!work.ok) throw new Error("not created");
    await addFacts(["I work at Infosys"], "you");
    await saveChatMessages("c1", say("work chat"));
    await deleteSpace(work.space.id);
    expect(Object.keys(store).filter((key) => key.includes(work.space.id))).toEqual([]);
    expect((await loadSpaces()).active.id).toBe(DEFAULT_SPACE_ID);
  });

  it("the first Space is emptied, never removed", async () => {
    await addFacts(["I live in Pune"], "you");
    await deleteSpace(DEFAULT_SPACE_ID);
    expect(await loadAboutMe()).toEqual([]);
    expect((await loadSpaces()).spaces).toHaveLength(1);
  });

  it("a backup comes back as a new Space without touching the old one", async () => {
    await addFacts(["I live in Pune"], "you");
    await saveInstructions("Prices in rupees");
    await saveChatMessages("c1", say("kettle prices"));
    const file = JSON.stringify(await backupSpace(DEFAULT_SPACE_ID));
    const parsed = parseSpaceBackup(file);
    expect(parsed?.space.name).toBe("Personal");
    expect(parseSpaceBackup("{}")).toBeNull();
    expect(parseSpaceBackup("not json")).toBeNull();

    const restored = await restoreSpace(parsed!);
    if (!restored.ok) throw new Error(restored.error);
    expect(restored.space.name).toBe("Personal (2)");
    expect((await loadSpaces()).active.id).toBe(DEFAULT_SPACE_ID);
    await switchSpace(restored.space.id);
    expect((await loadAboutMe()).map((fact) => fact.text)).toEqual(["I live in Pune"]);
    expect(await loadInstructions()).toBe("Prices in rupees");
    expect((await loadChats()).map((chat) => chat.title)).toEqual(["kettle prices"]);
  });

  it("recognises a key of any Space", () => {
    expect(isKeyFor("browserharness.chats", "browserharness.chats")).toBe(true);
    expect(isKeyFor("browserharness.chats@ab12", "browserharness.chats")).toBe(true);
    expect(isKeyFor("browserharness.chatsX", "browserharness.chats")).toBe(false);
  });
});
