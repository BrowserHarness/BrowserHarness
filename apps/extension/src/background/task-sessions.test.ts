import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  borrowTab,
  closeTaskSession,
  ensureTaskSession,
  getTaskSession,
  ownTab,
  selectSessionTab
} from "./task-sessions";

let sessionStore: Record<string, unknown>;
const removeTabs = vi.fn();

beforeEach(() => {
  sessionStore = {};
  removeTabs.mockReset();
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        session: {
          get: async (key: string) => ({
            [key]: sessionStore[key]
          }),
          set: async (value: Record<string, unknown>) => {
            Object.assign(sessionStore, value);
          }
        }
      },
      tabs: {
        remove: removeTabs
      }
    }
  });
});

describe("task sessions", () => {
  it("creates one persistent session record per task id", async () => {
    const first = await ensureTaskSession("task-1", "Research phones");
    const second = await ensureTaskSession("task-1", "Different label");
    expect(second).toEqual(first);
  });

  it("tracks borrowed and owned tabs separately", async () => {
    let session = await ensureTaskSession("task-1", "Research phones");
    session = await borrowTab(session, 10);
    session = await ownTab(session, 20);

    expect(session.borrowed_tab_ids).toEqual([10]);
    expect(session.owned_tab_ids).toEqual([20]);
    expect(session.current_tab_id).toBe(20);
  });

  it("refuses to select unrelated tabs", async () => {
    let session = await ensureTaskSession("task-1", "Research phones");
    session = await borrowTab(session, 10);

    await expect(selectSessionTab(session, 99)).rejects.toThrow(
      "not part of this BrowserCrew task session"
    );
  });

  it("closes only owned tabs when a session is closed", async () => {
    let session = await ensureTaskSession("task-1", "Research phones");
    session = await borrowTab(session, 10);
    session = await ownTab(session, 20);
    session = await ownTab(session, 21);

    const closed = await closeTaskSession(session);
    expect(closed).toBe(2);
    expect(removeTabs).toHaveBeenCalledWith([20, 21]);
    expect(await getTaskSession("task-1")).toBeNull();
  });
});
