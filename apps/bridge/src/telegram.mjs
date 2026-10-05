// Reach BrowserHarness from your phone: a Telegram bot that only answers the
// people you allowed on this computer. Each message becomes a browser task in
// Chrome; the result comes back as a reply. Steps that need approval stop and
// wait for you at the computer.

const DEFAULT_API = "https://api.telegram.org";
const MAX_MESSAGE = 3900;

export const TELEGRAM_HELP =
  "Send me a task, like “check my inbox for invoices” or “/your-skill size 9”, and I'll do it in Chrome on your computer and reply with the result. Anything that needs your approval waits for you there.";

export function telegramApi(token, apiBase = DEFAULT_API, fetchImpl = globalThis.fetch) {
  const call = async (method, body = {}, timeoutMs = 15_000) => {
    const response = await fetchImpl(`${apiBase}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const json = await response.json().catch(() => ({}));
    if (!json.ok) {
      throw new Error(json.description || `Telegram ${method} failed (${response.status})`);
    }
    return json.result;
  };
  return {
    getMe: () => call("getMe"),
    getUpdates: (offset, timeout = 30) =>
      call("getUpdates", { offset, timeout, allowed_updates: ["message"] }, (timeout + 10) * 1000),
    sendMessage: (chatId, text) =>
      call("sendMessage", { chat_id: chatId, text: text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text })
  };
}

const HEADINGS = { worked: "Done", failed: "Didn't finish", "needs you": "Needs you" };

/**
 * Polls the bot and turns allowed messages into tasks.
 * runTask(text, { from }) resolves to { ok, id } once Chrome accepted the task,
 * or { ok: false, error }. deliver(id, outcome) sends the result back.
 */
export function createTelegramRelay({
  token,
  allowedUserIds = [],
  apiBase = DEFAULT_API,
  fetchImpl = globalThis.fetch,
  runTask,
  pollTimeoutSeconds = 30,
  log = () => undefined
}) {
  const api = telegramApi(token, apiBase, fetchImpl);
  const allowed = new Set(allowedUserIds.map(String));
  const waiting = new Map();
  let offset = 0;
  let stopped = false;

  async function handle(update) {
    const message = update.message;
    if (!message?.chat?.id || typeof message.text !== "string") return;
    const chatId = message.chat.id;
    const text = message.text.trim();
    const userId = String(message.from?.id ?? "");
    if (!allowed.has(userId)) {
      await api.sendMessage(
        chatId,
        `This BrowserHarness bot is private. If it's yours, run this on your computer to allow this Telegram account:\n\nbrowserharness-bridge telegram allow ${userId}`
      );
      return;
    }
    if (!text || text === "/start" || text === "/help") {
      await api.sendMessage(chatId, TELEGRAM_HELP);
      return;
    }
    const accepted = await runTask(text, { from: "telegram", user: message.from?.first_name || "" });
    if (!accepted?.ok) {
      await api.sendMessage(chatId, `I couldn't start that: ${accepted?.error?.message || "Chrome is not connected."}`);
      return;
    }
    waiting.set(accepted.id, chatId);
    await api.sendMessage(chatId, `On it: ${text}`);
  }

  async function loop() {
    while (!stopped) {
      try {
        const updates = await api.getUpdates(offset, pollTimeoutSeconds);
        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);
          await handle(update).catch((error) => log(`telegram: ${error.message}`));
        }
      } catch (error) {
        if (stopped) break;
        log(`telegram: ${error instanceof Error ? error.message : String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  return {
    start() {
      void loop();
    },
    stop() {
      stopped = true;
    },
    /** Sends a finished task's result to the chat it came from. */
    async deliver(id, outcome) {
      const chatId = waiting.get(id);
      if (chatId === undefined) return false;
      waiting.delete(id);
      const heading = HEADINGS[outcome?.status] || "Finished";
      await api.sendMessage(chatId, `${heading}\n\n${String(outcome?.message || "").trim()}`);
      return true;
    },
    handle
  };
}
