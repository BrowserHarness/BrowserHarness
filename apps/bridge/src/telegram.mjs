// Reach BrowserHarness from your phone: a Telegram bot that only answers the
// people you allowed on this computer. Each message becomes a browser task in
// Chrome; the result comes back as a reply. Steps that need approval stop and
// wait for you at the computer.

import { CHAT_HELP, clipMessage, createChatRelay, pause } from "./chat-relay.mjs";
import { downloadVoice } from "./voice.mjs";

const DEFAULT_API = "https://api.telegram.org";
const MAX_MESSAGE = 3900;

export const TELEGRAM_HELP = CHAT_HELP;

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
    getFile: (fileId) => call("getFile", { file_id: fileId }),
    fileUrl: (filePath) => `${apiBase}/file/bot${token}/${filePath}`,
    sendMessage: (chatId, text) =>
      call("sendMessage", { chat_id: chatId, text: clipMessage(text, MAX_MESSAGE) })
  };
}

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
  transcribe = null,
  pollTimeoutSeconds = 30,
  log = () => undefined
}) {
  const api = telegramApi(token, apiBase, fetchImpl);
  const relay = createChatRelay({ app: "telegram", allowedUserIds, runTask, transcribe, send: (chatId, text) => api.sendMessage(chatId, text) });
  let offset = 0;
  let stopped = false;

  async function handle(update) {
    const message = update.message;
    const audio = message?.voice || message?.audio;
    if (!message?.chat?.id || (typeof message.text !== "string" && !audio?.file_id)) return;
    await relay.handle({
      chatId: message.chat.id,
      userId: message.from?.id,
      userName: message.from?.first_name || "",
      text: message.text || "",
      voice: audio?.file_id
        ? async () => {
            if (audio.file_size > 20 * 1024 * 1024) throw new Error("it is too long (20 MB at most)");
            const file = await api.getFile(audio.file_id);
            return downloadVoice(api.fileUrl(file.file_path), { type: audio.mime_type || "audio/ogg", name: file.file_path.split("/").pop() || "voice.ogg", fetchImpl });
          }
        : null
    });
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
        await pause(5000, () => stopped);
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
    app: relay.app,
    deliver: relay.deliver,
    notify: relay.notify,
    handle
  };
}
