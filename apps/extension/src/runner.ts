// The page a scheduled task runs in. The service worker opens it in a
// background tab when the task's alarm fires; it closes itself when done.
import { saveTaskHistoryEntry } from "./runtime/history";
import { runScheduledTask, runUnattendedTask } from "./runtime/scheduled-run";
import { deliveryText, describeSchedule, loadSchedules, recordScheduledRun } from "./runtime/schedules";

const title = document.getElementById("title") as HTMLElement;
const lines = document.getElementById("log") as HTMLElement;
const outcomeBox = document.getElementById("outcome") as HTMLElement;

function log(text: string) {
  const item = document.createElement("li");
  item.textContent = text;
  lines.append(item);
}

const HEADINGS = {
  worked: "Done",
  failed: "Didn't finish",
  "needs you": "Needs you"
} as const;

const CHAT_APPS: Record<string, string> = {
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
  signal: "Signal",
  mattermost: "Mattermost",
  matrix: "Matrix",
  email: "email"
};

/** A task sent from a chat app; the result goes back the same way. */
async function runRemote(id: string, keep: boolean) {
  const key = "browserharness.remoteTasks";
  const stored = ((await chrome.storage.session.get(key))[key] || {}) as Record<string, { text: string; from: string }>;
  const request = stored[id];
  if (!request) {
    title.textContent = "This task is no longer waiting.";
    return;
  }
  const { [id]: _done, ...rest } = stored;
  await chrome.storage.session.set({ [key]: rest });
  const source = CHAT_APPS[request.from] || "your phone";
  document.title = `Running: ${request.text}`;
  title.textContent = `Running a task from ${source}: ${request.text}`;
  const outcome = await runUnattendedTask(request.text, `From ${source}`, log);
  await saveTaskHistoryEntry({ task: `From ${source}: ${request.text}`, result: outcome.message, url: outcome.url }).catch(() => undefined);
  await chrome.runtime.sendMessage({ type: "REMOTE_TASK_RESULT", id, ...outcome }).catch(() => undefined);
  title.textContent = `${HEADINGS[outcome.status]}: ${request.text}`;
  outcomeBox.textContent = outcome.message;
  document.title = `${HEADINGS[outcome.status]}: ${request.text}`;
  if (!keep) setTimeout(() => window.close(), 5000);
}

async function main() {
  const params = new URLSearchParams(location.search);
  const remote = params.get("remote");
  if (remote) {
    await runRemote(remote, params.has("keep"));
    return;
  }
  const id = params.get("schedule") || "";
  const item = (await loadSchedules()).find((candidate) => candidate.id === id);
  if (!item) {
    title.textContent = "This scheduled task no longer exists.";
    return;
  }
  document.title = `Running: ${item.task}`;
  title.textContent = `Running your scheduled task: ${item.task}`;
  log(describeSchedule(item.schedule));

  const outcome = await runScheduledTask(item, log);
  await recordScheduledRun(item.id, outcome.status, outcome.message);
  await saveTaskHistoryEntry({ task: `Scheduled: ${item.task}`, result: outcome.message, url: outcome.url }).catch(() => undefined);
  if (item.deliver_to) {
    await chrome.runtime
      .sendMessage({ type: "CHAT_NOTIFY", app: item.deliver_to, text: deliveryText(item.task, outcome.status, outcome.message) })
      .then((sent: { ok?: boolean } | undefined) => log(sent?.ok ? `Sent the result to ${item.deliver_to}` : "Couldn't reach the Bridge to send the result"))
      .catch(() => undefined);
  }

  title.textContent = `${HEADINGS[outcome.status]}: ${item.task}`;
  outcomeBox.textContent = outcome.message;
  document.title = `${HEADINGS[outcome.status]}: ${item.task}`;
  try {
    chrome.notifications.create(`browserharness-run:${item.id}:${Date.now()}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: `${HEADINGS[outcome.status]}: ${item.task.slice(0, 60)}`,
      message: outcome.message.replace(/[*_`#|]/g, "").slice(0, 240),
      priority: outcome.status === "worked" ? 0 : 1
    });
  } catch {
    // Notifications may be turned off; the result is in history either way.
  }
  if (!params.has("keep")) setTimeout(() => window.close(), 5000);
}

void main();
