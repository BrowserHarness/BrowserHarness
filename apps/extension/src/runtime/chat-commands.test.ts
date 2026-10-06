import { describe, expect, it } from "vitest";
import { parseChatCommand, scheduleToTurnOff, schedulesText, statusText } from "./chat-commands";
import type { ScheduledTask } from "./schedules";

const schedule = (task: string, created_at: string, extra: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: task,
  task,
  schedule: { kind: "daily", time: "08:00", days: [0, 1, 2, 3, 4, 5, 6] },
  enabled: true,
  created_at,
  next_run_at: "2026-10-07T08:00:00.000Z",
  ...extra
});

describe("chat commands", () => {
  it("knows its commands and leaves everything else to the agent", () => {
    expect(parseChatCommand("/status")).toEqual({ kind: "status" });
    expect(parseChatCommand(" /STOP ")).toEqual({ kind: "stop" });
    expect(parseChatCommand("/schedules")).toEqual({ kind: "schedules" });
    expect(parseChatCommand("/unschedule #2")).toEqual({ kind: "unschedule", number: 2 });
    expect(parseChatCommand("/unschedule gold")).toEqual({ kind: "unschedule", number: null });
    expect(parseChatCommand("/schedule every day at 8 check prices")).toBeNull();
    expect(parseChatCommand("/stopwatch-skill")).toBeNull();
    expect(parseChatCommand("stop the music on youtube")).toBeNull();
  });

  it("says what is running and what comes next", () => {
    const now = new Date("2026-10-06T10:00:00.000Z");
    const text = statusText(
      [{ id: "a", text: "find flights", from: "telegram", tab_id: 1, started_at: "2026-10-06T09:57:00.000Z" }],
      [schedule("check gold", "2026-10-01T00:00:00Z"), schedule("old one", "2026-10-02T00:00:00Z", { enabled: false })],
      now
    );
    expect(text).toContain("• find flights (from Telegram, started 3 min ago)");
    expect(text).toContain("check gold");
    expect(text).not.toContain("old one");
    expect(statusText([], [], now)).toContain("Nothing is running right now.");
  });

  it("numbers schedules in a stable order and turns off the one asked for", () => {
    const items = [schedule("second", "2026-10-02T00:00:00Z", { deliver_to: "slack" }), schedule("first", "2026-10-01T00:00:00Z", { enabled: false })];
    const text = schedulesText(items);
    expect(text.indexOf("1. first")).toBeGreaterThan(-1);
    expect(text).toContain("(off)");
    expect(text).toMatch(/2\. second\n   Every day at .+, results to Slack/);
    expect(scheduleToTurnOff(items, 2)).toEqual({ item: items[0] });
    expect(scheduleToTurnOff(items, 1)).toEqual({ reply: "“first” is already off." });
    expect(scheduleToTurnOff(items, 9)).toEqual({ reply: "Send /unschedule and the number from /schedules, between 1 and 2." });
    expect(schedulesText([])).toContain("no scheduled tasks");
  });
});
