// Saved chats, like the list down the side of Claude or ChatGPT. Every chat
// is kept as it happens, in the Space it was started in, so closing the panel
// never loses a conversation. People can rename, pin, delete or save a chat
// as a file.
import { keyForSpace, spaceKey, SPACE_SCOPED_KEYS } from "./spaces";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  at?: string;
  /** Set when the answer was a "couldn't finish" card, so it shows as one again. */
  problem?: unknown;
}

export interface SavedChat {
  id: string;
  title: string;
  /** True once the person renamed it, so it never gets an automatic title again. */
  named?: boolean;
  pinned?: boolean;
  created_at: string;
  updated_at: string;
  messages: ChatMessage[];
}

const KEY = SPACE_SCOPED_KEYS.chats;
export const MAX_CHATS = 300;
export const MAX_CHAT_MESSAGES = 400;
export const MAX_TITLE = 80;

async function key(spaceId?: string): Promise<string> {
  return spaceId ? keyForSpace(KEY, spaceId) : spaceKey(KEY);
}

/** Newest first, pinned chats on top. */
export function sortChats(chats: SavedChat[]): SavedChat[] {
  return [...chats].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updated_at.localeCompare(a.updated_at));
}

export async function loadChats(spaceId?: string): Promise<SavedChat[]> {
  const k = await key(spaceId);
  const value = (await chrome.storage.local.get(k))[k];
  return Array.isArray(value) ? sortChats(value as SavedChat[]) : [];
}

async function store(chats: SavedChat[], spaceId?: string): Promise<void> {
  // The oldest unpinned chats make room when the list is full.
  const sorted = sortChats(chats);
  const kept = sorted.length > MAX_CHATS ? [...sorted.filter((chat) => chat.pinned), ...sorted.filter((chat) => !chat.pinned)].slice(0, MAX_CHATS) : sorted;
  await chrome.storage.local.set({ [await key(spaceId)]: kept });
}

export async function getChat(id: string, spaceId?: string): Promise<SavedChat | null> {
  return (await loadChats(spaceId)).find((chat) => chat.id === id) ?? null;
}

/** A short name from the first thing the person asked. */
export function chatTitle(messages: Pick<ChatMessage, "role" | "text">[]): string {
  const first = messages.find((message) => message.role === "user")?.text ?? "";
  const line = first.replace(/\s+/g, " ").trim();
  if (!line) return "New chat";
  return line.length > 48 ? `${line.slice(0, 47).replace(/\s+\S*$/, "")}…` : line;
}

/** Saves the chat's messages, creating it on first save. Empty chats are never saved. */
export async function saveChatMessages(id: string, messages: ChatMessage[], spaceId?: string): Promise<SavedChat | null> {
  const kept = messages.filter((message) => message.text.trim() || message.problem).slice(-MAX_CHAT_MESSAGES);
  if (!kept.some((message) => message.role === "user")) return null;
  const chats = await loadChats(spaceId);
  const now = new Date().toISOString();
  const existing = chats.find((chat) => chat.id === id);
  const chat: SavedChat = existing
    ? { ...existing, messages: kept, updated_at: now, title: existing.named ? existing.title : chatTitle(kept) }
    : { id, title: chatTitle(kept), created_at: now, updated_at: now, messages: kept };
  await store(existing ? chats.map((item) => (item.id === id ? chat : item)) : [chat, ...chats], spaceId);
  return chat;
}

export async function renameChat(id: string, title: string): Promise<boolean> {
  const value = title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  if (!value) return false;
  const chats = await loadChats();
  await store(chats.map((chat) => (chat.id === id ? { ...chat, title: value, named: true } : chat)));
  return true;
}

export async function setChatPinned(id: string, pinned: boolean): Promise<void> {
  const chats = await loadChats();
  await store(chats.map((chat) => (chat.id === id ? { ...chat, pinned } : chat)));
}

export async function deleteChat(id: string): Promise<void> {
  await store((await loadChats()).filter((chat) => chat.id !== id));
}

export async function deleteAllChats(): Promise<void> {
  await chrome.storage.local.remove(await key());
}

/** Chats whose title or messages contain every word, best matches (titles) first. */
export function searchChats(chats: SavedChat[], query: string): SavedChat[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return chats;
  const scored = chats
    .map((chat) => {
      const title = chat.title.toLowerCase();
      const body = chat.messages.map((message) => message.text).join("\n").toLowerCase();
      if (!words.every((word) => title.includes(word) || body.includes(word))) return null;
      return { chat, score: words.filter((word) => title.includes(word)).length };
    })
    .filter((item): item is { chat: SavedChat; score: number } => Boolean(item));
  return scored.sort((a, b) => b.score - a.score).map((item) => item.chat);
}

/** "Today", "Yesterday", "Previous 7 days", "Previous 30 days" or the month. */
export function chatGroup(updatedAt: string, now = new Date()): string {
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const then = new Date(updatedAt);
  const days = Math.round((day(now) - day(then)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days <= 7) return "Previous 7 days";
  if (days <= 30) return "Previous 30 days";
  return then.toLocaleDateString([], { month: "long", year: "numeric" });
}

/** The words of the chat people see, without cards or buttons. */
function plainAnswer(message: ChatMessage): string {
  const problem = message.problem as { problem?: { title?: string; reason?: string } } | undefined;
  if (problem?.problem?.title) return `${problem.problem.title}. ${problem.problem.reason ?? ""}`.trim();
  return message.text;
}

function stamp(iso: string): string {
  return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

/** The chat as a Markdown document, readable in any notes app. */
export function chatToMarkdown(chat: SavedChat, spaceName?: string): string {
  const lines = [`# ${chat.title}`, "", `Saved from BrowserHarness${spaceName ? `, Space “${spaceName}”` : ""}, ${stamp(chat.updated_at)}.`, ""];
  for (const message of chat.messages) {
    lines.push(`## ${message.role === "user" ? "You" : "BrowserHarness"}${message.at ? ` (${stamp(message.at)})` : ""}`, "", plainAnswer(message).trim(), "");
  }
  return `${lines.join("\n").trim()}\n`;
}

/** The chat as plain text, for people who just want to read or print it. */
export function chatToText(chat: SavedChat, spaceName?: string): string {
  const lines = [chat.title, "=".repeat(Math.min(chat.title.length, 60)), `Saved from BrowserHarness${spaceName ? `, Space “${spaceName}”` : ""}, ${stamp(chat.updated_at)}.`, ""];
  for (const message of chat.messages) {
    lines.push(`${message.role === "user" ? "You" : "BrowserHarness"}:`, plainAnswer(message).trim(), "");
  }
  return `${lines.join("\n").trim()}\n`;
}

/** A file name that works on every computer. */
export function chatFileName(title: string, extension: string): string {
  const base = title
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 50);
  return `${base || "chat"}.${extension}`;
}

/**
 * The earlier turns of this chat, so a follow-up like "make it shorter" or
 * "what about the second one?" makes sense to the AI. Newest turns win when
 * the chat is long.
 */
export function chatContextPrompt(messages: Pick<ChatMessage, "role" | "text">[], maxChars = 6000): string {
  const turns: string[] = [];
  let used = 0;
  for (const message of [...messages].reverse()) {
    const text = message.text.trim();
    if (!text) continue;
    const line = `${message.role === "user" ? "Me" : "You"}: ${text.length > 1500 ? `${text.slice(0, 1500)}…` : text}`;
    if (used + line.length > maxChars) break;
    turns.unshift(line);
    used += line.length;
  }
  if (!turns.length) return "";
  return ["", "", "EARLIER IN THIS CHAT (for context; answer my new message above, using this only where it helps):", ...turns].join("\n");
}
