// What every chat app has in common: only people you allowed on this
// computer can use the bot, each message becomes a browser task in Chrome,
// and the result goes back to the chat it came from. Each app (Telegram,
// Discord, Slack, Signal) only says how messages come in and go out.

export const HEADINGS = { worked: "Done", failed: "Didn't finish", "needs you": "Needs you" };

export const CHAT_APP_NAMES = {
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
  signal: "Signal",
  mattermost: "Mattermost",
  matrix: "Matrix",
  email: "email"
};

export const VOICE_OFF =
  "I got your voice note, but voice notes aren't turned on for this bot. Type the task instead, or turn them on at your computer: browserharness-bridge voice setup --url <speech-to-text service> --model <its model>";

export const CHAT_HELP =
  "Send me a task, like “check my inbox for invoices” or “/your-skill size 9”, and I'll do it in Chrome on your computer and reply with the result. Anything that needs your approval waits for you there.\n\n/status: what's running and coming up\n/stop: stop what you started here\n/schedule every weekday at 8am …: a scheduled task\n/schedules: your scheduled tasks (/unschedule 2 turns one off)";

// People who messaged a bot but aren't allowed yet, newest last, so Settings
// in Chrome can offer an Allow button instead of a command.
const strangers = new Map();

function noteStranger(app, id, name) {
  const key = `${app}:${id}`;
  strangers.delete(key);
  strangers.set(key, { app, id, name: String(name || "").slice(0, 80), at: new Date().toISOString() });
  while (strangers.size > 20) strangers.delete(strangers.keys().next().value);
}

/** Who is waiting to be allowed, for one app. */
export function waitingStrangers(app) {
  return [...strangers.values()].filter((entry) => entry.app === app);
}

/** Forgets a waiting person (once allowed, or when the app is turned off). */
export function forgetStranger(app, id) {
  if (id === undefined) {
    for (const entry of waitingStrangers(app)) strangers.delete(`${app}:${entry.id}`);
  } else {
    strangers.delete(`${app}:${id}`);
  }
}

/** Cuts a reply to what the app accepts. */
export function clipMessage(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The shared part of a chat bot.
 * send(chatId, text) sends a reply. runTask(text, { from, user }) resolves to
 * { ok, id } once Chrome accepted the task, or { ok: false, error }.
 * handle({ chatId, userId, userName, text, voice }) takes one incoming message;
 * voice() downloads a voice note ({ data, type, name }) and is only called for
 * allowed people, then transcribe(audio) turns it into the task's words.
 * deliver(id, outcome) sends a finished task's result back; notify(text)
 * reaches every allowed account, at targetFor(userId) (default: the id itself).
 * allow(ids) replaces who may use the bot.
 */
export function createChatRelay({ app, allowedUserIds = [], send, runTask, help = CHAT_HELP, targetFor = async (userId) => userId, transcribe = null }) {
  const allowed = new Set(allowedUserIds.map(String));
  const waiting = new Map();

  async function handle({ chatId, userId, userName = "", text, voice = null }) {
    let task = String(text || "").trim();
    const user = String(userId ?? "");
    if (!user || !allowed.has(user)) {
      if (user) noteStranger(app, user, userName);
      await send(
        chatId,
        `This BrowserHarness bot is private. If it's yours, open BrowserHarness in Chrome, go to Settings, then Phone & chat apps, and press Allow next to this ${CHAT_APP_NAMES[app]} account.\n\nOr run this on your computer:\n\nbrowserharness-bridge ${app} allow ${user}`
      );
      return;
    }
    let heard = false;
    if (!task && voice) {
      if (!transcribe) {
        await send(chatId, VOICE_OFF);
        return;
      }
      try {
        task = String(await transcribe(await voice())).trim();
      } catch (error) {
        await send(chatId, `I couldn't make out that voice note: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (!task) {
        await send(chatId, "I couldn't hear any words in that voice note. Try again, or type the task.");
        return;
      }
      heard = true;
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
    // Some requests (like /schedule) are answered at once.
    if (accepted.reply) {
      await send(chatId, accepted.reply);
      return;
    }
    waiting.set(accepted.id, chatId);
    await send(chatId, heard ? `On it (from your voice note): ${task}` : `On it: ${task}`);
  }

  async function deliver(id, outcome) {
    if (!waiting.has(id)) return false;
    const chatId = waiting.get(id);
    waiting.delete(id);
    const heading = HEADINGS[outcome?.status] || "Finished";
    await send(chatId, `${heading}\n\n${String(outcome?.message || "").trim()}`);
    return true;
  }

  /** Sends a message nobody asked for (a scheduled result) to every allowed account. */
  async function notify(text) {
    let sent = 0;
    for (const userId of allowed) {
      await send(await targetFor(userId), text);
      sent += 1;
    }
    return sent;
  }

  /** Changes who may use the bot, without restarting it. */
  function allow(ids) {
    allowed.clear();
    for (const id of ids) allowed.add(String(id));
  }

  return { app, handle, deliver, notify, allow };
}

/** Waits, unless stopped first. */
export function pause(ms, isStopped = () => false) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => (isStopped() || Date.now() - started >= ms ? resolve() : setTimeout(tick, Math.min(250, ms)));
    tick();
  });
}
