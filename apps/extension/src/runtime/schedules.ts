// Scheduled tasks: "every weekday at 8am check my inbox". The service worker
// sets a Chrome alarm for each one; when it fires, a runner tab does the task
// in its own background tab and leaves the result in history and a
// notification.

import { activeSpaceId } from "./spaces";

export type Schedule =
  | { kind: "once"; at: string }
  | { kind: "daily"; time: string; days: number[] }
  | { kind: "interval"; minutes: number };

/** Chat apps the Bridge can send results to. */
export type ChatApp = "telegram" | "discord" | "slack" | "signal" | "mattermost" | "matrix" | "email";
export const CHAT_APP_LABELS: Record<ChatApp, string> = {
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
  signal: "Signal",
  mattermost: "Mattermost",
  matrix: "Matrix",
  email: "email"
};

export function isChatApp(value: unknown): value is ChatApp {
  return typeof value === "string" && value in CHAT_APP_LABELS;
}

export interface ScheduledTask {
  id: string;
  /** What to do, in the person's words; "/skill-name details" runs a Skill. */
  task: string;
  schedule: Schedule;
  enabled: boolean;
  created_at: string;
  next_run_at?: string;
  last_run_at?: string;
  last_status?: "worked" | "failed" | "needs you";
  last_result?: string;
  /** Also send each result to this chat app. */
  deliver_to?: ChatApp;
  /** The Space it was made in: its runs use that Space's notes and history. */
  space_id?: string;
}

const KEY = "browserharness.schedules";
const MAX_SCHEDULES = 50;
export const MIN_INTERVAL_MINUTES = 15;
export const ALARM_PREFIX = "browserharness-schedule:";

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function parseTime(time: string): { hours: number; minutes: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? { hours, minutes } : null;
}

/** When the schedule fires next, strictly after `from`; null when it never will. */
export function nextRunAt(schedule: Schedule, from: Date): Date | null {
  if (schedule.kind === "once") {
    const at = new Date(schedule.at);
    return Number.isNaN(at.getTime()) || at <= from ? null : at;
  }
  if (schedule.kind === "interval") {
    const minutes = Math.max(MIN_INTERVAL_MINUTES, Math.round(schedule.minutes));
    return new Date(from.getTime() + minutes * 60_000);
  }
  const time = parseTime(schedule.time);
  const days = schedule.days.filter((day) => day >= 0 && day <= 6);
  if (!time || !days.length) return null;
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(from);
    candidate.setDate(from.getDate() + offset);
    candidate.setHours(time.hours, time.minutes, 0, 0);
    if (candidate > from && days.includes(candidate.getDay())) return candidate;
  }
  return null;
}

function clock(time: string): string {
  const parsed = parseTime(time);
  if (!parsed) return time;
  const date = new Date(2000, 0, 1, parsed.hours, parsed.minutes);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function describeSchedule(schedule: Schedule): string {
  if (schedule.kind === "once") {
    return `Once, ${new Date(schedule.at).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
  }
  if (schedule.kind === "interval") {
    const minutes = Math.max(MIN_INTERVAL_MINUTES, schedule.minutes);
    if (minutes % 60 === 0) {
      const hours = minutes / 60;
      return hours === 1 ? "Every hour" : `Every ${hours} hours`;
    }
    return `Every ${minutes} minutes`;
  }
  const days = [...new Set(schedule.days)].sort();
  const key = days.join(",");
  const when =
    key === EVERY_DAY.join(",")
      ? "Every day"
      : key === WEEKDAYS.join(",")
        ? "Every weekday"
        : key === WEEKEND.join(",")
          ? "Every weekend day"
          : `Every ${days.map((day) => DAY_NAMES[day]).join(", ")}`;
  return `${when} at ${clock(schedule.time)}`;
}

function time24(hour: number, minute: number, meridiem?: string): string | null {
  let hours = hour;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hours = meridiem.toLowerCase().startsWith("p") ? (hour % 12) + 12 : hour % 12;
  }
  if (hours > 23 || minute > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

const TIME = String.raw`(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?`;

/**
 * Reads "every weekday at 8am …", "every day at 18:30 …", "every monday at
 * 9 …", "every 2 hours …", "tomorrow at 7am …", "in 30 minutes …" from the
 * start of the text. Returns the schedule and the task that follows.
 */
export function parseScheduleText(text: string, now = new Date()): { schedule: Schedule; task: string } | null {
  const source = text.trim();
  const lower = source.toLowerCase();
  const rest = (length: number) => source.slice(length).replace(/^[\s,:;-]+(to\s+)?/i, "").trim();

  const interval = /^every\s+(\d+)?\s*(minute|minutes|min|mins|hour|hours|hr|hrs)\b/.exec(lower);
  if (interval) {
    const count = Number(interval[1] || 1);
    const minutes = interval[2].startsWith("h") ? count * 60 : count;
    return { schedule: { kind: "interval", minutes: Math.max(MIN_INTERVAL_MINUTES, minutes) }, task: rest(interval[0].length) };
  }

  const recurring = new RegExp(
    String.raw`^(?:every\s+(day|weekday|weekend|morning|evening|night|sunday|monday|tuesday|wednesday|thursday|friday|saturday)|daily)(?:\s+at\s+${TIME})?\b`
  ).exec(lower);
  if (recurring) {
    const unit = recurring[1] || "day";
    const days =
      unit === "weekday"
        ? WEEKDAYS
        : unit === "weekend"
          ? WEEKEND
          : DAY_NAMES.map((day) => day.toLowerCase()).includes(unit)
            ? [DAY_NAMES.map((day) => day.toLowerCase()).indexOf(unit)]
            : EVERY_DAY;
    const fallbackHour = unit === "evening" ? 18 : unit === "night" ? 21 : 8;
    const time = recurring[2]
      ? time24(Number(recurring[2]), Number(recurring[3] || 0), recurring[4])
      : time24(fallbackHour, 0);
    if (!time) return null;
    return { schedule: { kind: "daily", time, days }, task: rest(recurring[0].length) };
  }

  const relative = /^in\s+(\d+)\s*(minute|minutes|min|mins|hour|hours|hr|hrs)\b/.exec(lower);
  if (relative) {
    const minutes = Number(relative[1]) * (relative[2].startsWith("h") ? 60 : 1);
    return { schedule: { kind: "once", at: new Date(now.getTime() + minutes * 60_000).toISOString() }, task: rest(relative[0].length) };
  }

  const once = new RegExp(String.raw`^(today|tomorrow)\s+at\s+${TIME}\b`).exec(lower);
  if (once) {
    const time = time24(Number(once[2]), Number(once[3] || 0), once[4]);
    if (!time) return null;
    const [hours, minutes] = time.split(":").map(Number);
    const at = new Date(now);
    if (once[1] === "tomorrow") at.setDate(at.getDate() + 1);
    at.setHours(hours, minutes, 0, 0);
    return { schedule: { kind: "once", at: at.toISOString() }, task: rest(once[0].length) };
  }

  return null;
}

const DELIVERY = /[\s,;]*(?:and\s+)?(?:send|message|text|tell)\s+(?:me\s+)?(?:(?:it|that|the\s+results?|results?)\s+)?(?:to\s+me\s+)?(?:to|on|in|via|over)\s+(?:my\s+)?(telegram|discord|slack|signal|mattermost|matrix|e-?mail)\s*[.!]?\s*$/i;
const EMAIL_ME = /[\s,;]*(?:and\s+)?e-?mail\s+me(?:\s+(?:it|that|the\s+results?|results?))?\s*[.!]?\s*$/i;

/** "check prices and send it to Telegram" → the task, and where results go. */
export function splitDelivery(text: string): { task: string; deliver_to?: ChatApp } {
  const match = DELIVERY.exec(text);
  if (match) {
    const app = match[1].toLowerCase().replace("-", "");
    return { task: text.slice(0, match.index).trim(), deliver_to: app as ChatApp };
  }
  const email = EMAIL_ME.exec(text);
  return email ? { task: text.slice(0, email.index).trim(), deliver_to: "email" } : { task: text.trim() };
}

/** The message a chat app gets after a scheduled run. */
export function deliveryText(task: string, status: NonNullable<ScheduledTask["last_status"]>, result: string): string {
  const heading = status === "worked" ? "Done" : status === "failed" ? "Didn't finish" : "Needs you";
  return `${heading}: ${task}\n\n${result.trim()}`;
}

export async function setScheduleDelivery(id: string, app: ChatApp | undefined): Promise<void> {
  const items = await loadSchedules();
  await store(items.map((item) => (item.id === id ? { ...item, deliver_to: app } : item)));
}

export async function loadSchedules(): Promise<ScheduledTask[]> {
  const stored = await chrome.storage.local.get(KEY);
  const value = stored[KEY];
  return Array.isArray(value) ? (value as ScheduledTask[]) : [];
}

async function store(items: ScheduledTask[]): Promise<void> {
  await chrome.storage.local.set({ [KEY]: items.slice(0, MAX_SCHEDULES) });
}

export function newScheduledTask(task: string, schedule: Schedule, now = new Date()): ScheduledTask {
  return {
    id: crypto.randomUUID(),
    task: task.trim(),
    schedule,
    enabled: true,
    created_at: now.toISOString(),
    next_run_at: nextRunAt(schedule, now)?.toISOString()
  };
}

export async function saveScheduledTask(item: ScheduledTask): Promise<void> {
  const items = await loadSchedules();
  const exists = items.some((current) => current.id === item.id);
  if (!exists && !item.space_id) item = { ...item, space_id: await activeSpaceId() };
  await store(exists ? items.map((current) => (current.id === item.id ? item : current)) : [item, ...items]);
}

export async function deleteScheduledTask(id: string): Promise<void> {
  await store((await loadSchedules()).filter((item) => item.id !== id));
}

export async function setScheduleEnabled(id: string, enabled: boolean, now = new Date()): Promise<void> {
  const items = await loadSchedules();
  await store(
    items.map((item) =>
      item.id === id
        ? { ...item, enabled, next_run_at: enabled ? nextRunAt(item.schedule, now)?.toISOString() : undefined }
        : item
    )
  );
}

/**
 * Called when the alarm fires: moves the next run on at once, so the alarm
 * is not set again for a run that has already started.
 */
export async function markScheduleStarted(id: string, now = new Date()): Promise<ScheduledTask | null> {
  const items = await loadSchedules();
  const item = items.find((current) => current.id === id);
  if (!item || !item.enabled) return null;
  const updated = { ...item, next_run_at: nextRunAt(item.schedule, now)?.toISOString() };
  await store(items.map((current) => (current.id === id ? updated : current)));
  return updated;
}

/** Alarms to set: enabled schedules with a next run; missed runs catch up soon. */
export function plannedAlarms(items: ScheduledTask[], now = new Date()): Array<{ id: string; when: number }> {
  return items
    .filter((item) => item.enabled && item.next_run_at)
    .map((item) => {
      const when = Date.parse(item.next_run_at as string);
      return { id: item.id, when: Number.isNaN(when) ? now.getTime() + 10_000 : Math.max(when, now.getTime() + 10_000) };
    });
}

/** Records a run and moves the schedule on; a one-off turns itself off. */
export async function recordScheduledRun(
  id: string,
  status: NonNullable<ScheduledTask["last_status"]>,
  result: string,
  now = new Date()
): Promise<ScheduledTask | null> {
  const items = await loadSchedules();
  const item = items.find((current) => current.id === id);
  if (!item) return null;
  const next = nextRunAt(item.schedule, now);
  const updated: ScheduledTask = {
    ...item,
    last_run_at: now.toISOString(),
    last_status: status,
    last_result: result.slice(0, 2000),
    next_run_at: item.enabled ? next?.toISOString() : undefined,
    enabled: item.enabled && Boolean(next)
  };
  await store(items.map((current) => (current.id === id ? updated : current)));
  return updated;
}

export const SCHEDULES_STORAGE_KEY = KEY;
