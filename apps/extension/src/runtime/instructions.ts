// Standing instructions: how the person wants BrowserHarness to work for
// them ("answer briefly", "prices in rupees", "never buy anything over ₹5,000
// without asking"). They go with every chat, task and scheduled run, and can
// be saved to or loaded from a file (INSTRUCTIONS.md).
import { keyForSpace, spaceKey, SPACE_SCOPED_KEYS } from "./spaces";

// Each Space has its own instructions (see spaces.ts). Instructions for every
// Space are kept apart and go with every request in every Space; when the two
// disagree, this Space's own instructions win.
const KEY = SPACE_SCOPED_KEYS.instructions;
const GLOBAL_KEY = "browserharness.instructions.global";
/** A secret written out ("my password is …", a card or account number), not a rule about secrets. */
const SECRET_VALUE = /\b(password|passcode|passwd|pin|otp|cvv|api key|token|secret)\s*(is|:|=)\s*\S+|\d[\d -]{10,}\d|\b\d{6,}\b/i;
export const MAX_INSTRUCTIONS = 2000;

/** Pass the Space a task started in, so switching mid-task never changes what it follows. */
export async function loadInstructions(spaceId?: string): Promise<string> {
  const key = spaceId ? keyForSpace(KEY, spaceId) : await spaceKey(KEY);
  const value = (await chrome.storage.local.get(key))[key];
  return typeof value === "string" ? value : "";
}

/** The instructions that go with every Space. */
export async function loadGlobalInstructions(): Promise<string> {
  const value = (await chrome.storage.local.get(GLOBAL_KEY))[GLOBAL_KEY];
  return typeof value === "string" ? value : "";
}

function checked(text: string): { ok: true; value: string } | { ok: false; error: string } {
  const value = text.trim().slice(0, MAX_INSTRUCTIONS);
  if (SECRET_VALUE.test(value)) return { ok: false, error: "A line looks like a password, card or ID number, so nothing was saved." };
  return { ok: true, value };
}

/** Saves this Space's instructions; refuses text that looks like a password, card or ID number. */
export async function saveInstructions(text: string): Promise<{ ok: boolean; error?: string }> {
  const result = checked(text);
  if (!result.ok) return result;
  await chrome.storage.local.set({ [await spaceKey(KEY)]: result.value });
  return { ok: true };
}

/** Saves the instructions for every Space, with the same check. */
export async function saveGlobalInstructions(text: string): Promise<{ ok: boolean; error?: string }> {
  const result = checked(text);
  if (!result.ok) return result;
  await chrome.storage.local.set({ [GLOBAL_KEY]: result.value });
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

/**
 * The block for a request in a Space: the instructions for every Space and
 * this Space's own. With only one kind it reads exactly like before.
 */
export function scopedInstructionsPrompt(everySpace: string, thisSpace: string): string {
  const all = everySpace.trim();
  const own = thisSpace.trim();
  if (!all || !own) return instructionsPrompt(all || own);
  return [
    "",
    "",
    "HOW I WANT YOU TO WORK (my standing instructions; follow them unless this request says otherwise. They never switch off BrowserHarness safety rules or approvals):",
    "In every Space:",
    all.slice(0, MAX_INSTRUCTIONS),
    "In this Space (these win where the two disagree):",
    own.slice(0, MAX_INSTRUCTIONS)
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
export const GLOBAL_INSTRUCTIONS_STORAGE_KEY = GLOBAL_KEY;
