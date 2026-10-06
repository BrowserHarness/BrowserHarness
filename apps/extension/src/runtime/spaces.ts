// Spaces: separate places for separate parts of someone's life ("Work",
// "Family trip", "Home"). Each Space keeps its own chats, its own notes about
// the person, its own standing instructions and its own past conversations,
// so nothing from one leaks into another. Skills, connected AIs, safety
// choices and scheduled tasks are shared by every Space.
//
// The first Space ("Personal") uses the storage keys BrowserHarness always
// used, so nothing has to move when someone updates. Every other Space adds
// "@<space id>" to the end of each key.

export interface Space {
  id: string;
  name: string;
  /** One of SPACE_COLORS, so the Space is easy to recognise at a glance. */
  color: string;
  created_at: string;
}

interface SpacesState {
  spaces: Space[];
  active: string;
}

export const DEFAULT_SPACE_ID = "personal";
export const SPACES_STORAGE_KEY = "browserharness.spaces";
export const MAX_SPACES = 20;
export const MAX_SPACE_NAME = 40;
export const SPACE_COLORS = ["#4f6bed", "#16a34a", "#d97706", "#db2777", "#7c3aed", "#0891b2", "#dc2626", "#64748b"];

/** What each Space keeps for itself. Everything else is shared. */
export const SPACE_SCOPED_KEYS = {
  chats: "browserharness.chats",
  aboutMe: "browserharness.aboutMe",
  instructions: "browserharness.instructions",
  history: "browserharness.taskHistory"
} as const;

/**
 * Stores shared by every Space whose records each carry the Space they
 * belong to (space_id; none means the first Space). Deleting a Space removes
 * its records from these too, and nothing else.
 */
export const SPACE_TAGGED_KEYS = {
  skills: "browserharness.skills",
  episodes: "browserharness.taskEpisodes.v1"
} as const;

const KEY = SPACES_STORAGE_KEY;

export function defaultSpace(): Space {
  return { id: DEFAULT_SPACE_ID, name: "Personal", color: SPACE_COLORS[0], created_at: new Date(0).toISOString() };
}

function isSpace(value: unknown): value is Space {
  const space = value as Space;
  return Boolean(space) && typeof space.id === "string" && typeof space.name === "string";
}

async function loadState(): Promise<SpacesState> {
  const stored = (await chrome.storage.local.get(KEY))[KEY] as Partial<SpacesState> | undefined;
  const saved = Array.isArray(stored?.spaces) ? stored!.spaces.filter(isSpace) : [];
  // The first Space always exists, so the old keys are never orphaned.
  const spaces = saved.some((space) => space.id === DEFAULT_SPACE_ID) ? saved : [defaultSpace(), ...saved];
  const active = spaces.some((space) => space.id === stored?.active) ? stored!.active! : DEFAULT_SPACE_ID;
  return { spaces, active };
}

async function storeState(state: SpacesState): Promise<void> {
  await chrome.storage.local.set({ [KEY]: state });
}

export async function loadSpaces(): Promise<{ spaces: Space[]; active: Space }> {
  const state = await loadState();
  return { spaces: state.spaces, active: state.spaces.find((space) => space.id === state.active)! };
}

// A background run (a scheduled task) works in the Space it was made in, even
// if the person has since switched. Each extension page has its own copy of
// this module, so pinning here never changes what the side panel shows.
let pinned: string | null = null;
export function pinSpace(id: string | null | undefined): void {
  pinned = id || null;
}

export async function activeSpaceId(): Promise<string> {
  if (pinned) return pinned;
  return (await loadState()).active;
}

export function keyForSpace(base: string, spaceId: string): string {
  return spaceId === DEFAULT_SPACE_ID ? base : `${base}@${spaceId}`;
}

/** The storage key for this kind of data in the Space in use right now. */
export async function spaceKey(base: string): Promise<string> {
  return keyForSpace(base, await activeSpaceId());
}

/** True when a changed storage key is this kind of data, in any Space. */
export function isKeyFor(changed: string, base: string): boolean {
  return changed === base || changed.startsWith(`${base}@`);
}

export function cleanSpaceName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, MAX_SPACE_NAME);
}

export async function createSpace(name: string, options: { switchTo?: boolean } = {}): Promise<{ ok: true; space: Space } | { ok: false; error: string }> {
  const value = cleanSpaceName(name);
  if (!value) return { ok: false, error: "Give the Space a name, like Work or Family." };
  const state = await loadState();
  if (state.spaces.length >= MAX_SPACES) return { ok: false, error: `You can have up to ${MAX_SPACES} Spaces. Delete one you no longer use first.` };
  if (state.spaces.some((space) => space.name.toLowerCase() === value.toLowerCase())) {
    return { ok: false, error: `You already have a Space called ${value}.` };
  }
  const space: Space = {
    id: crypto.randomUUID().slice(0, 8),
    name: value,
    color: SPACE_COLORS[state.spaces.length % SPACE_COLORS.length],
    created_at: new Date().toISOString()
  };
  await storeState({ spaces: [...state.spaces, space], active: options.switchTo === false ? state.active : space.id });
  return { ok: true, space };
}

export async function renameSpace(id: string, name: string): Promise<{ ok: boolean; error?: string }> {
  const value = cleanSpaceName(name);
  if (!value) return { ok: false, error: "The name can't be empty." };
  const state = await loadState();
  if (state.spaces.some((space) => space.id !== id && space.name.toLowerCase() === value.toLowerCase())) {
    return { ok: false, error: `You already have a Space called ${value}.` };
  }
  await storeState({ ...state, spaces: state.spaces.map((space) => (space.id === id ? { ...space, name: value } : space)) });
  return { ok: true };
}

export async function setSpaceColor(id: string, color: string): Promise<void> {
  const state = await loadState();
  await storeState({ ...state, spaces: state.spaces.map((space) => (space.id === id ? { ...space, color } : space)) });
}

export async function switchSpace(id: string): Promise<void> {
  const state = await loadState();
  if (!state.spaces.some((space) => space.id === id)) return;
  await storeState({ ...state, active: id });
}

/**
 * Deletes a Space and everything it kept (chats, notes about you,
 * instructions, past conversations). The first Space can only be emptied,
 * never removed, so there is always somewhere to be.
 */
export async function deleteSpace(id: string): Promise<void> {
  const state = await loadState();
  await chrome.storage.local.remove(Object.values(SPACE_SCOPED_KEYS).map((base) => keyForSpace(base, id)));
  await removeTaggedRecords(id);
  if (id === DEFAULT_SPACE_ID) return;
  const spaces = state.spaces.filter((space) => space.id !== id);
  await storeState({ spaces, active: state.active === id ? DEFAULT_SPACE_ID : state.active });
}

/** Removes one Space's own records from the shared stores; shared-with-everyone ones stay. */
async function removeTaggedRecords(id: string): Promise<void> {
  for (const key of Object.values(SPACE_TAGGED_KEYS)) {
    const value = (await chrome.storage.local.get(key))[key];
    if (!Array.isArray(value)) continue;
    const kept = value.filter((record: { space_id?: string; visibility?: string }) => {
      // Skills from before Spaces had a say carry no tag and are shared by every Space.
      if (record?.visibility === "all" || (key === SPACE_TAGGED_KEYS.skills && !record?.space_id)) return true;
      return (record?.space_id || DEFAULT_SPACE_ID) !== id;
    });
    if (kept.length !== value.length) await chrome.storage.local.set({ [key]: kept });
  }
}

/** Everything a Space keeps, as one file people can save and bring back later. */
export interface SpaceBackup {
  kind: "browserharness-space-backup";
  version: 1;
  saved_at: string;
  space: { name: string; color: string };
  data: Partial<Record<keyof typeof SPACE_SCOPED_KEYS, unknown>>;
}

export async function backupSpace(id: string): Promise<SpaceBackup> {
  const { spaces } = await loadSpaces();
  const space = spaces.find((item) => item.id === id) ?? defaultSpace();
  const data: SpaceBackup["data"] = {};
  for (const [name, base] of Object.entries(SPACE_SCOPED_KEYS) as [keyof typeof SPACE_SCOPED_KEYS, string][]) {
    const key = keyForSpace(base, id);
    const value = (await chrome.storage.local.get(key))[key];
    if (value !== undefined) data[name] = value;
  }
  return { kind: "browserharness-space-backup", version: 1, saved_at: new Date().toISOString(), space: { name: space.name, color: space.color }, data };
}

export function parseSpaceBackup(text: string): SpaceBackup | null {
  try {
    const value = JSON.parse(text.replace(/^﻿/, "")) as SpaceBackup;
    if (value?.kind !== "browserharness-space-backup" || typeof value.space?.name !== "string" || typeof value.data !== "object") return null;
    return value;
  } catch {
    return null;
  }
}

/** Brings a backup back as a new Space, so nothing already here is overwritten. */
export async function restoreSpace(backup: SpaceBackup): Promise<{ ok: true; space: Space } | { ok: false; error: string }> {
  const { spaces } = await loadSpaces();
  const taken = new Set(spaces.map((space) => space.name.toLowerCase()));
  let name = cleanSpaceName(backup.space.name) || "Restored";
  for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${cleanSpaceName(backup.space.name)} (${n})`;
  const created = await createSpace(name, { switchTo: false });
  if (!created.ok) return created;
  if (SPACE_COLORS.includes(backup.space.color)) await setSpaceColor(created.space.id, backup.space.color);
  const values: Record<string, unknown> = {};
  for (const [name, base] of Object.entries(SPACE_SCOPED_KEYS) as [keyof typeof SPACE_SCOPED_KEYS, string][]) {
    const value = backup.data[name];
    if (name === "instructions" ? typeof value === "string" : Array.isArray(value)) values[keyForSpace(base, created.space.id)] = value;
  }
  await chrome.storage.local.set(values);
  return { ok: true, space: { ...created.space, color: SPACE_COLORS.includes(backup.space.color) ? backup.space.color : created.space.color } };
}
