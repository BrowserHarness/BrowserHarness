// What every chat app has in common: only people you allowed on this
// computer can use the bot, each message becomes a browser task in Chrome,
// and the result goes back to the chat it came from. Each app (Telegram,
// Discord, Slack, Signal) only says how messages come in and go out.

export const HEADINGS = { worked: "Done", failed: "Didn't finish", "needs you": "Needs you" };

export const CHAT_APP_NAMES = { telegram: "Telegram", discord: "Discord", slack: "Slack", signal: "Signal" };

export const CHAT_HELP =
  "Send me a task, like “check my inbox for invoices” or “/your-skill size 9”, and I'll do it in Chrome on your computer and reply with the result. Anything that needs your approval waits for you there.";

/** Cuts a reply to what the app accepts. */
export function clipMessage(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The shared part of a chat bot.
 * send(chatId, text) sends a reply. runTask(text, { from, user }) resolves to
 * { ok, id } once Chrome accepted the task, or { ok: false, error }.
 * handle({ chatId, userId, userName, text }) takes one incoming message;
 * deliver(id, outcome) sends a finished task's result back.
 */
export function createChatRelay({ app, allowedUserIds = [], send, runTask, help = CHAT_HELP }) {
  const allowed = new Set(allowedUserIds.map(String));
  const waiting = new Map();

  async function handle({ chatId, userId, userName = "", text }) {
    const task = String(text || "").trim();
    const user = String(userId ?? "");
    if (!user || !allowed.has(user)) {
      await send(
        chatId,
        `This BrowserHarness bot is private. If it's yours, run this on your computer to allow this ${CHAT_APP_NAMES[app]} account:\n\nbrowserharness-bridge ${app} allow ${user}`
      );
      return;
    }
    if (!task || task === "/start" || task === "/help" || task.toLowerCase() === "help") {
      await send(chatId, help);
      return;
    }
    const accepted = await runTask(task, { from: app, user: userName });
    if (!accepted?.ok) {
      await send(chatId, `I couldn't start that: ${accepted?.error?.message || "Chrome is not connected."}`);
      return;
    }
    waiting.set(accepted.id, chatId);
    await send(chatId, `On it: ${task}`);
  }

  async function deliver(id, outcome) {
    if (!waiting.has(id)) return false;
    const chatId = waiting.get(id);
    waiting.delete(id);
    const heading = HEADINGS[outcome?.status] || "Finished";
    await send(chatId, `${heading}\n\n${String(outcome?.message || "").trim()}`);
    return true;
  }

  return { handle, deliver };
}

/** Waits, unless stopped first. */
export function pause(ms, isStopped = () => false) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => (isStopped() || Date.now() - started >= ms ? resolve() : setTimeout(tick, Math.min(250, ms)));
    tick();
  });
}
