import { beforeEach, describe, expect, it } from "vitest";
import {
  chatContextPrompt,
  chatFileName,
  chatGroup,
  chatTitle,
  chatToMarkdown,
  chatToText,
  deleteChat,
  getChat,
  loadChats,
  renameChat,
  saveChatMessages,
  searchChats,
  setChatPinned,
  type ChatMessage
} from "./chats";

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
            Object.assign(store, structuredClone(value));
          },
          remove: async (key: string) => {
            delete store[key];
          }
        }
      }
    }
  });
});

const turn = (role: ChatMessage["role"], text: string): ChatMessage => ({ id: crypto.randomUUID(), role, text, at: "2026-10-06T08:00:00.000Z" });

describe("saved chats", () => {
  it("names a chat from the first request and never saves an empty one", async () => {
    expect(await saveChatMessages("a", [turn("assistant", "Hello")])).toBeNull();
    const chat = await saveChatMessages("a", [turn("user", "Find me the cheapest electric kettle on Amazon under 2000 rupees please"), turn("assistant", "The Philips one")]);
    expect(chat?.title).toBe("Find me the cheapest electric kettle on Amazon…");
    expect(await loadChats()).toHaveLength(1);
  });

  it("keeps a name the person chose", async () => {
    await saveChatMessages("a", [turn("user", "kettles")]);
    await renameChat("a", "Kitchen shopping");
    await saveChatMessages("a", [turn("user", "kettles"), turn("assistant", "Here")]);
    expect((await getChat("a"))?.title).toBe("Kitchen shopping");
  });

  it("puts pinned chats first, then the newest", async () => {
    await saveChatMessages("old", [turn("user", "old one")]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await saveChatMessages("new", [turn("user", "new one")]);
    expect((await loadChats()).map((chat) => chat.id)).toEqual(["new", "old"]);
    await setChatPinned("old", true);
    expect((await loadChats()).map((chat) => chat.id)).toEqual(["old", "new"]);
    await deleteChat("old");
    expect((await loadChats()).map((chat) => chat.id)).toEqual(["new"]);
  });

  it("finds chats by any words in them, title matches first", async () => {
    await saveChatMessages("a", [turn("user", "plan a trip"), turn("assistant", "Goa has beaches")]);
    await saveChatMessages("b", [turn("user", "beaches in Goa")]);
    const chats = await loadChats();
    expect(searchChats(chats, "goa beaches").map((chat) => chat.id)).toEqual(["b", "a"]);
    expect(searchChats(chats, "kettle")).toEqual([]);
    expect(searchChats(chats, "")).toHaveLength(2);
  });

  it("groups chats by when they were last used", () => {
    const now = new Date(2026, 9, 6, 12);
    expect(chatGroup(new Date(2026, 9, 6, 9).toISOString(), now)).toBe("Today");
    expect(chatGroup(new Date(2026, 9, 5, 23).toISOString(), now)).toBe("Yesterday");
    expect(chatGroup(new Date(2026, 9, 1).toISOString(), now)).toBe("Previous 7 days");
    expect(chatGroup(new Date(2026, 8, 20).toISOString(), now)).toBe("Previous 30 days");
  });

  it("saves a chat as a document or plain text, with problem cards in words", () => {
    const chat = {
      id: "a",
      title: "Kettles",
      created_at: "2026-10-06T08:00:00.000Z",
      updated_at: "2026-10-06T08:00:00.000Z",
      messages: [
        turn("user", "find kettles"),
        { ...turn("assistant", "x"), problem: { problem: { title: "Your AI didn't answer", reason: "It took too long." } } }
      ]
    };
    const markdown = chatToMarkdown(chat, "Home");
    expect(markdown).toContain("# Kettles");
    expect(markdown).toContain("Space “Home”");
    expect(markdown).toContain("## You");
    expect(markdown).toContain("Your AI didn't answer. It took too long.");
    const text = chatToText(chat);
    expect(text).toContain("You:\nfind kettles");
    expect(text).not.toContain("#");
    expect(chatFileName("Kettles: under ₹2000?", "md")).toBe("kettles-under-2000.md");
    expect(chatFileName("???", "txt")).toBe("chat.txt");
  });

  it("gives the AI the latest turns of the chat, within a limit", () => {
    expect(chatContextPrompt([])).toBe("");
    const prompt = chatContextPrompt([turn("user", "find kettles"), turn("assistant", "Philips at 1599")]);
    expect(prompt).toContain("EARLIER IN THIS CHAT");
    expect(prompt).toContain("Me: find kettles");
    expect(prompt).toContain("You: Philips at 1599");
    const long = Array.from({ length: 20 }, (_, index) => turn("user", `${index} ${"x".repeat(900)}`));
    const trimmed = chatContextPrompt(long, 3000);
    expect(trimmed).toContain("19 ");
    expect(trimmed).not.toContain("\nMe: 0 ");
  });

  it("titles from the first request", () => {
    expect(chatTitle([])).toBe("New chat");
    expect(chatTitle([{ role: "user", text: "  hi\nthere " }])).toBe("hi there");
  });
});
