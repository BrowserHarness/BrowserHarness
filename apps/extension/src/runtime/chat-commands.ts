// Commands people can send their chat-app bot besides tasks: what's running
// and coming up (/status), stop what they started (/stop), and see or turn
// off their scheduled tasks (/schedules, /unschedule 2). Answered at once,
// without a model.
import { CHAT_APP_LABELS, describeSchedule, isChatApp, type ScheduledTask } from "./schedules";

export type ChatCommand =
  | { kind: "status" }
  | { kind: "stop" }
  | { kind: "schedules" }
  | { kind: "unschedule"; number: number | null };

/** A task started from a chat app that is still running in its own tab. */
export interface RunningChatTask {
  id: string;
  text: string;
  from: string;
  tab_id: number;
  started_at: string;
}

export const RUNNING_CHAT_TASKS_KEY = "browserharness.remoteRunning";

export function parseChatCommand(text: string): ChatCommand | null {
  const match = /^\/(status|stop|schedules|unschedule)\b\s*(.*)$/i.exec(text.trim());
  if (!match) return null;
  const kind = match[1].toLowerCase() as ChatCommand["kind"];
  if (kind !== "unschedule") return { kind };
  const number = /^#?(\d{1,3})$/.exec(match[2].trim())?.[1];
  return { kind, number: number ? Number(number) : null };
}

function ago(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

function where(item: ScheduledTask): string {
  return isChatApp(item.deliver_to) ? `, results to ${CHAT_APP_LABELS[item.deliver_to]}` : "";
}

/** Schedules in a fixed order, so "/unschedule 2" means the second one listed. */
export function orderedSchedules(items: ScheduledTask[]): ScheduledTask[] {
  return [...items].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function statusText(running: RunningChatTask[], schedules: ScheduledTask[], now = new Date()): string {
  const lines: string[] = [];
  lines.push(
    running.length
      ? `Running now:\n${running.map((task) => `• ${task.text} (from ${CHAT_APP_LABELS[task.from as keyof typeof CHAT_APP_LABELS] || "your phone"}, started ${ago(task.started_at, now)})`).join("\n")}`
      : "Nothing is running right now."
  );
  const upcoming = schedules
    .filter((item) => item.enabled && item.next_run_at)
    .sort((a, b) => String(a.next_run_at).localeCompare(String(b.next_run_at)))
    .slice(0, 3);
  if (upcoming.length) lines.push(`Coming up:\n${upcoming.map((item) => `• ${when(item.next_run_at!)}: ${item.task}`).join("\n")}`);
  lines.push("Send /stop to stop what you started here, or /schedules to see your scheduled tasks.");
  return lines.join("\n\n");
}

export function schedulesText(schedules: ScheduledTask[]): string {
  const items = orderedSchedules(schedules);
  if (!items.length) return "You have no scheduled tasks. Make one like “/schedule every weekday at 8am check my inbox for invoices”.";
  return [
    "Your scheduled tasks:",
    ...items.map(
      (item, index) => `${index + 1}. ${item.task}\n   ${describeSchedule(item.schedule)}${item.enabled ? "" : " (off)"}${where(item)}`
    ),
    "",
    "Send /unschedule and a number to turn one off. Delete them under History → Scheduled."
  ].join("\n");
}

/** Which schedule "/unschedule N" means, or what to say instead. */
export function scheduleToTurnOff(schedules: ScheduledTask[], number: number | null): { item: ScheduledTask } | { reply: string } {
  const items = orderedSchedules(schedules);
  if (!items.length) return { reply: "You have no scheduled tasks." };
  if (number === null || number < 1 || number > items.length) {
    return { reply: `Send /unschedule and the number from /schedules, between 1 and ${items.length}.` };
  }
  const item = items[number - 1];
  if (!item.enabled) return { reply: `“${item.task}” is already off.` };
  return { item };
}
