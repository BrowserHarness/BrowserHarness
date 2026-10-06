// Memory scope: which part of someone's life a remembered thing belongs to.
// A Space is a hard wall. Anything remembered inside one Space (a past task,
// what a helper found, a learned Skill) is only ever read back inside that
// same Space, and the wall is enforced here, on the stored records, before
// any search or ranking runs. Nothing reaches another Space by being similar.
//
// Scopes, widest first: global (the person, every Space) → space → task.
// Agent (a helper inside a task) and Skill are extra labels on a record, not
// separate stores.
import { activeSpaceId, DEFAULT_SPACE_ID } from "./spaces";

export type MemoryScopeType = "global" | "space" | "task" | "agent" | "skill";

export interface MemoryScope {
  type: MemoryScopeType;
  space_id?: string;
  task_id?: string;
  agent_id?: string;
  skill_id?: string;
}

/** Something stored with the Space it belongs to. */
export interface SpaceTagged {
  space_id?: string;
  /** "all": deliberately shared with every Space (only for things made before Spaces, or shared on purpose). */
  visibility?: "space" | "all";
}

/**
 * The Space a stored record belongs to. Records saved before Spaces had no
 * tag; they were made in the first Space ("Personal"), which keeps the old
 * storage keys too, so that is where they stay.
 */
export function recordSpace(record: SpaceTagged): string {
  return record.space_id || DEFAULT_SPACE_ID;
}

/** True when a record may be read inside this Space. The one place the wall is checked. */
export function visibleInSpace(record: SpaceTagged, spaceId: string): boolean {
  if (record.visibility === "all") return true;
  return recordSpace(record) === spaceId;
}

/** Only the records this Space may see. Run this before searching, never after. */
export function withinSpace<T extends SpaceTagged>(records: T[], spaceId: string): T[] {
  return records.filter((record) => visibleInSpace(record, spaceId));
}

/**
 * The Space a piece of work uses. Pass the Space captured when the work
 * started; only fall back to the one in use right now for calls that have no
 * task behind them (a settings screen, a coding agent asking).
 */
export async function resolveSpace(spaceId?: string | null): Promise<string> {
  return spaceId || (await activeSpaceId());
}

/** The scope of a task started in a Space; helpers inside it add their own id. */
export function taskScope(spaceId: string, taskId: string, agentId?: string): MemoryScope {
  return agentId
    ? { type: "agent", space_id: spaceId, task_id: taskId, agent_id: agentId }
    : { type: "task", space_id: spaceId, task_id: taskId };
}
