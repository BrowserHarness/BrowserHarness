import { beforeEach, describe, expect, it } from "vitest";
import {
  describeSchedule,
  loadSchedules,
  newScheduledTask,
  nextRunAt,
  parseScheduleText,
  recordScheduledRun,
  saveScheduledTask,
  setScheduleEnabled
} from "./schedules";

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
            Object.assign(store, value);
          },
          remove: async (key: string) => {
            delete store[key];
          }
        }
      }
    }
  });
});

// Friday 2026-10-09, 09:30 local time.
const friday = new Date(2026, 9, 9, 9, 30);

describe("schedules", () => {
  it("finds the next run for daily, weekday, interval and one-off schedules", () => {
    expect(nextRunAt({ kind: "daily", time: "08:00", days: [1, 2, 3, 4, 5] }, friday)).toEqual(new Date(2026, 9, 12, 8, 0));
    expect(nextRunAt({ kind: "daily", time: "18:15", days: [0, 1, 2, 3, 4, 5, 6] }, friday)).toEqual(new Date(2026, 9, 9, 18, 15));
    expect(nextRunAt({ kind: "interval", minutes: 5 }, friday)).toEqual(new Date(2026, 9, 9, 9, 45));
    expect(nextRunAt({ kind: "once", at: new Date(2026, 9, 9, 9, 0).toISOString() }, friday)).toBeNull();
    expect(nextRunAt({ kind: "daily", time: "25:00", days: [1] }, friday)).toBeNull();
  });

  it("reads schedules written in plain words", () => {
    expect(parseScheduleText("every weekday at 8am check my inbox for invoices", friday)).toEqual({
      schedule: { kind: "daily", time: "08:00", days: [1, 2, 3, 4, 5] },
      task: "check my inbox for invoices"
    });
    expect(parseScheduleText("every monday at 9:30 pm, to export the sales report", friday)).toEqual({
      schedule: { kind: "daily", time: "21:30", days: [1] },
      task: "export the sales report"
    });
    expect(parseScheduleText("every 2 hours check the price of the kettle on amazon.in")?.schedule).toEqual({ kind: "interval", minutes: 120 });
    expect(parseScheduleText("every 5 minutes ping")?.schedule).toEqual({ kind: "interval", minutes: 15 });
    expect(parseScheduleText("tomorrow at 7am book the gym slot", friday)?.schedule).toEqual({
      kind: "once",
      at: new Date(2026, 9, 10, 7, 0).toISOString()
    });
    expect(parseScheduleText("in 30 minutes remind me", friday)?.schedule).toEqual({
      kind: "once",
      at: new Date(2026, 9, 9, 10, 0).toISOString()
    });
    expect(parseScheduleText("check my inbox")).toBeNull();
    expect(parseScheduleText("every day at 13pm x")).toBeNull();
  });

  it("describes schedules for people", () => {
    expect(describeSchedule({ kind: "daily", time: "08:00", days: [1, 2, 3, 4, 5] })).toMatch(/^Every weekday at 8:00/);
    expect(describeSchedule({ kind: "daily", time: "08:00", days: [0, 1, 2, 3, 4, 5, 6] })).toMatch(/^Every day at/);
    expect(describeSchedule({ kind: "interval", minutes: 120 })).toBe("Every 2 hours");
  });

  it("records runs, moves the next run on and turns finished one-offs off", async () => {
    const once = newScheduledTask("do it", { kind: "once", at: new Date(2026, 9, 9, 10, 0).toISOString() }, friday);
    const daily = newScheduledTask("check", { kind: "daily", time: "08:00", days: [1, 2, 3, 4, 5] }, friday);
    await saveScheduledTask(once);
    await saveScheduledTask(daily);
    const after = new Date(2026, 9, 9, 10, 1);
    expect(await recordScheduledRun(once.id, "worked", "Done", after)).toMatchObject({ enabled: false, last_status: "worked", next_run_at: undefined });
    expect(await recordScheduledRun(daily.id, "needs you", "Asked to approve", after)).toMatchObject({
      enabled: true,
      next_run_at: new Date(2026, 9, 12, 8, 0).toISOString()
    });
    await setScheduleEnabled(daily.id, false, after);
    expect((await loadSchedules()).find((item) => item.id === daily.id)).toMatchObject({ enabled: false, next_run_at: undefined });
  });
});
