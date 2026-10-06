// Reach BrowserHarness from Slack: your own Slack app answers your direct
// messages, or an @mention in a channel, and only for the people you allowed
// on this computer. It uses Socket Mode, so nothing on your computer has to
// be reachable from the internet.
import { WebSocket } from "ws";
import { clipMessage, createChatRelay, pause } from "./chat-relay.mjs";

const DEFAULT_API = "https://slack.com/api";
const MAX_MESSAGE = 3900;

export function slackApi({ botToken, appToken, apiBase = DEFAULT_API, fetchImpl = globalThis.fetch }) {
  const call = async (method, token, body = {}) => {
    const response = await fetchImpl(`${apiBase}/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000)
    });
    const json = await response.json().catch(() => ({}));
    if (!json.ok) throw new Error(`Slack ${method} failed: ${json.error || response.status}`);
    return json;
  };
  return {
    /** Checks the bot token: { user_id, user, team }. */
    authTest: () => call("auth.test", botToken),
    /** A fresh Socket Mode address for the app token. */
    openConnection: () => call("apps.connections.open", appToken),
    sendMessage: (channel, text) => call("chat.postMessage", botToken, { channel, text: clipMessage(text, MAX_MESSAGE) })
  };
}

/** The task in an event, or null when the app should stay quiet. */
export function slackTask(event) {
  if (!event || event.bot_id || event.subtype || typeof event.text !== "string") return null;
  if (event.type === "app_mention") return event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
  if (event.type === "message" && event.channel_type === "im") return event.text;
  return null;
}

export function createSlackRelay({
  botToken,
  appToken,
  allowedUserIds = [],
  apiBase = DEFAULT_API,
  fetchImpl = globalThis.fetch,
  runTask,
  log = () => undefined
}) {
  const api = slackApi({ botToken, appToken, apiBase, fetchImpl });
  const relay = createChatRelay({ app: "slack", allowedUserIds, runTask, send: (channel, text) => api.sendMessage(channel, text) });
  let socket = null;
  let stopped = false;
  const seen = new Set();

  async function handle(event) {
    const text = slackTask(event);
    if (text === null) return;
    // Slack retries events it thinks were missed; run each message once.
    const key = event.client_msg_id || `${event.channel}:${event.ts}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 500) seen.delete(seen.values().next().value);
    await relay.handle({ chatId: event.channel, userId: event.user, text });
  }

  /** One Socket Mode connection; resolves when it closes, with whether to try again. */
  async function connect() {
    let url;
    try {
      url = (await api.openConnection()).url;
    } catch (error) {
      log(`slack: ${error.message}`);
      return !/invalid_auth|not_authed|account_inactive|token_revoked/.test(error.message);
    }
    return new Promise((resolve) => {
      socket = new WebSocket(url);
      socket.on("message", (raw) => {
        let envelope;
        try {
          envelope = JSON.parse(String(raw));
        } catch {
          return;
        }
        // Every envelope is acknowledged at once, or Slack sends it again.
        if (envelope.envelope_id) socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
        if (envelope.type === "disconnect") {
          socket.close(1000);
        } else if (envelope.type === "events_api") {
          handle(envelope.payload?.event).catch((error) => log(`slack: ${error.message}`));
        }
      });
      socket.on("error", (error) => log(`slack: ${error.message}`));
      socket.on("close", () => resolve(true));
    });
  }

  async function loop() {
    let failures = 0;
    while (!stopped) {
      const started = Date.now();
      const again = await connect();
      if (!again) {
        log("slack: the app was turned away. Check the tokens with: browserharness-bridge slack setup --bot-token <xoxb-…> --app-token <xapp-…>");
        break;
      }
      if (stopped) break;
      failures = Date.now() - started < 10_000 ? failures + 1 : 0;
      // A planned reconnect is immediate; repeated quick failures back off.
      await pause(failures ? Math.min(60_000, 2000 * 2 ** failures) : 0, () => stopped);
    }
  }

  return {
    start() {
      void loop();
    },
    stop() {
      stopped = true;
      socket?.close(1000);
    },
    deliver: relay.deliver,
    handle
  };
}
