// Spaces: separate places for separate parts of someone's life ("Work",
// "Family trip", "Home"). Each Space keeps its own chats, its own notes about
// the person, its own standing instructions and its own past conversations,
// so nothing from one leaks into another. Its own decisions, Skills, task
// evidence and scheduled tasks live in shared stores tagged with the Space.
// Connected AIs, safety choices, settings and anything deliberately set "for
// every Space" are shared.
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

/** Stores each Space keeps under its own key. Its records in shared stores are tagged (below). */
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
  episodes: "browserharness.taskEpisodes.v1",
  decisions: "browserharness.decisions.v1"
} as const;

/** Scheduled tasks: shared store, each one run in the Space named by its space_id. */
export const SCHEDULES_KEY = "browserharness.schedules";

export type OwnedKind = keyof typeof SPACE_TAGGED_KEYS | "schedules";

/**
 * True when a record in a shared store is owned by this Space: what a Space
 * backup takes and what deleting the Space removes. Owning is not seeing:
 * anything shared with every Space (visibility "all", or a Skill from before
 * Skills belonged to a Space) is owned by no Space. A schedule belongs to a
 * Space only when it names one.
 */
export function ownedBySpaceId(kind: OwnedKind, record: unknown, id: string): boolean {
  if (!record || typeof record !== "object") return false;
  const item = record as { space_id?: unknown; visibility?: unknown; scope?: unknown };
  if (kind === "schedules") return typeof item.space_id === "string" && item.space_id === id;
  if (item.visibility === "all" || item.scope === "global") return false;
  if (kind === "skills" && !item.space_id) return false;
  return ((typeof item.space_id === "string" && item.space_id) || DEFAULT_SPACE_ID) === id;
}

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

export async function createSpace(name: string, options: { switchTo?: boolean; id?: string; color?: string } = {}): Promise<{ ok: true; space: Space } | { ok: false; error: string }> {
  const value = cleanSpaceName(name);
  if (!value) return { ok: false, error: "Give the Space a name, like Work or Family." };
  const state = await loadState();
  if (state.spaces.length >= MAX_SPACES) return { ok: false, error: `You can have up to ${MAX_SPACES} Spaces. Delete one you no longer use first.` };
  if (state.spaces.some((space) => space.name.toLowerCase() === value.toLowerCase())) {
    return { ok: false, error: `You already have a Space called ${value}.` };
  }
  if (options.id && (options.id === DEFAULT_SPACE_ID || state.spaces.some((space) => space.id === options.id))) {
    return { ok: false, error: "That Space already exists." };
  }
  const space: Space = {
    id: options.id || crypto.randomUUID().slice(0, 8),
    name: value,
    color: options.color && SPACE_COLORS.includes(options.color) ? options.color : SPACE_COLORS[state.spaces.length % SPACE_COLORS.length],
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
 * Deletes a Space and everything it owns: chats, notes about you,
 * instructions, past conversations, and its own decisions, Skills, task
 * evidence and scheduled tasks. Anything set for every Space stays. The first
 * Space can only be emptied (the same things go), never removed, so there is
 * always somewhere to be.
 */
export async function deleteSpace(id: string): Promise<void> {
  const state = await loadState();
  await chrome.storage.local.remove(Object.values(SPACE_SCOPED_KEYS).map((base) => keyForSpace(base, id)));
  await removeTaggedRecords(id);
  if (id === DEFAULT_SPACE_ID) return;
  const spaces = state.spaces.filter((space) => space.id !== id);
  await storeState({ spaces, active: state.active === id ? DEFAULT_SPACE_ID : state.active });
}

/**
 * Removes one Space's own records from the shared stores, its scheduled
 * tasks included (a schedule must never run for a Space that is gone);
 * shared-with-everyone ones stay. Their alarms go when the store changes.
 */
async function removeTaggedRecords(id: string): Promise<void> {
  const stores: Array<[OwnedKind, string]> = [...(Object.entries(SPACE_TAGGED_KEYS) as Array<[OwnedKind, string]>), ["schedules", SCHEDULES_KEY]];
  for (const [kind, key] of stores) {
    const value = (await chrome.storage.local.get(key))[key];
    if (!Array.isArray(value)) continue;
    const kept = value.filter((record) => !ownedBySpaceId(kind, record, id));
    if (kept.length !== value.length) await chrome.storage.local.set({ [key]: kept });
  }
}
