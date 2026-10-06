// Standing instructions: how the person wants BrowserHarness to work for
// them ("answer briefly", "prices in rupees", "never buy anything over ₹5,000
// without asking"). They go with every chat, task and scheduled run, and can
// be saved to or loaded from a file (INSTRUCTIONS.md).
import { keyForSpace, spaceKey, SPACE_SCOPED_KEYS } from "./spaces";

// Each Space has its own instructions (see spaces.ts).
const KEY = SPACE_SCOPED_KEYS.instructions;
/** A secret written out ("my password is …", a card or account number), not a rule about secrets. */
const SECRET_VALUE = /\b(password|passcode|passwd|pin|otp|cvv|api key|token|secret)\s*(is|:|=)\s*\S+|\d[\d -]{10,}\d|\b\d{6,}\b/i;
export const MAX_INSTRUCTIONS = 2000;

/** Pass the Space a task started in, so switching mid-task never changes what it follows. */
export async function loadInstructions(spaceId?: string): Promise<string> {
  const key = spaceId ? keyForSpace(KEY, spaceId) : await spaceKey(KEY);
  const value = (await chrome.storage.local.get(key))[key];
  return typeof value === "string" ? value : "";
}

/** Saves the instructions; refuses text that looks like a password, card or ID number. */
export async function saveInstructions(text: string): Promise<{ ok: boolean; error?: string }> {
  const value = text.trim().slice(0, MAX_INSTRUCTIONS);
  if (SECRET_VALUE.test(value)) return { ok: false, error: "A line looks like a password, card or ID number, so nothing was saved." };
  await chrome.storage.local.set({ [await spaceKey(KEY)]: value });
  return { ok: true };
}

/** The block added to every request. */
export function instructionsPrompt(text: string): string {
  const value = text.trim();
  if (!value) return "";
  return [
    "",
    "",
    "HOW I WANT YOU TO WORK (my standing instructions; follow them unless this request says otherwise. They never switch off BrowserHarness safety rules or approvals):",
    value.slice(0, MAX_INSTRUCTIONS)
  ].join("\n");
}

/** The file people can keep or share, and read back. */
export function instructionsFile(text: string): string {
  return `# How BrowserHarness should work for me\n\n${text.trim()}\n`;
}

export function instructionsFromFile(file: string): string {
  return file
    .replace(/^﻿/, "")
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/^#[^\n]*\n+/, "")
    .trim()
    .slice(0, MAX_INSTRUCTIONS);
}

export const INSTRUCTIONS_STORAGE_KEY = KEY;
