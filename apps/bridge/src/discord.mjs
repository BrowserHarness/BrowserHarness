// Reach BrowserHarness from Discord: your own bot answers your direct
// messages, or a mention in a server, and only for the accounts you allowed
// on this computer. It needs no special permissions: Discord shares the text
// of direct messages and mentions with every bot.
import { WebSocket } from "ws";
import { clipMessage, createChatRelay, pause } from "./chat-relay.mjs";

const DEFAULT_API = "https://discord.com/api/v10";
const DEFAULT_GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";
const MAX_MESSAGE = 1990;
// Server messages and direct messages; message text comes with mentions and DMs.
const INTENTS = (1 << 9) | (1 << 12);
// Close codes that will never work by retrying: bad token, bad intents.
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

export function discordApi(token, apiBase = DEFAULT_API, fetchImpl = globalThis.fetch) {
  const call = async (method, pathname, body) => {
    const response = await fetchImpl(`${apiBase}${pathname}`, {
      method,
      headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000)
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.message || `Discord ${pathname} failed (${response.status})`);
    return json;
  };
  return {
    getMe: () => call("GET", "/users/@me"),
    /** The direct-message channel with a person, for messages they didn't ask for. */
    openDm: (userId) => call("POST", "/users/@me/channels", { recipient_id: userId }),
    sendMessage: (channelId, text) => call("POST", `/channels/${channelId}/messages`, { content: clipMessage(text, MAX_MESSAGE) })
  };
}

/** The link that adds the bot to a server, so you can message it. */
export function discordInviteUrl(botId) {
  // View channels + Send messages.
  return `https://discord.com/oauth2/authorize?client_id=${botId}&scope=bot&permissions=3072`;
}

/** The task in a message, or null when the bot should stay quiet. */
export function discordTask(message, botId) {
  if (!message || message.author?.bot || typeof message.content !== "string") return null;
  if (!message.guild_id) return message.content;
  const mentioned = (message.mentions || []).some((user) => user.id === botId);
  if (!mentioned) return null;
  return message.content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
}

export function createDiscordRelay({
  token,
  allowedUserIds = [],
  apiBase = DEFAULT_API,
  gatewayUrl = DEFAULT_GATEWAY,
  botId: knownBotId = "",
  fetchImpl = globalThis.fetch,
  runTask,
  log = () => undefined
}) {
  const api = discordApi(token, apiBase, fetchImpl);
  const relay = createChatRelay({
    app: "discord",
    allowedUserIds,
    runTask,
    send: (channelId, text) => api.sendMessage(channelId, text),
    targetFor: async (userId) => (await api.openDm(userId)).id
  });
  let botId = knownBotId;
  let socket = null;
  let stopped = false;

  async function handle(message) {
    const text = discordTask(message, botId);
    if (text === null) return;
    await relay.handle({ chatId: message.channel_id, userId: message.author?.id, userName: message.author?.username || "", text });
  }

  /** One gateway connection; resolves when it closes, with whether to try again. */
  function connect() {
    return new Promise((resolve) => {
      let heartbeat = null;
      let sequence = null;
      socket = new WebSocket(gatewayUrl);
      const send = (payload) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify(payload));
      socket.on("message", (raw) => {
        let packet;
        try {
          packet = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (packet.s != null) sequence = packet.s;
        if (packet.op === 10) {
          const every = Number(packet.d?.heartbeat_interval) || 41_250;
          heartbeat = setInterval(() => send({ op: 1, d: sequence }), every);
          send({
            op: 2,
            d: { token, intents: INTENTS, properties: { os: process.platform, browser: "browserharness", device: "browserharness" } }
          });
        } else if (packet.op === 1) {
          send({ op: 1, d: sequence });
        } else if (packet.op === 7 || packet.op === 9) {
          socket.close(4000);
        } else if (packet.op === 0 && packet.t === "READY") {
          botId = packet.d?.user?.id || botId;
        } else if (packet.op === 0 && packet.t === "MESSAGE_CREATE") {
          handle(packet.d).catch((error) => log(`discord: ${error.message}`));
        }
      });
      socket.on("error", (error) => log(`discord: ${error.message}`));
      socket.on("close", (code) => {
        clearInterval(heartbeat);
        if (FATAL_CLOSE.has(code)) {
          log(`discord: the bot was turned away (${code}). Check the token with: browserharness-bridge discord setup --token <token>`);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  }

  async function loop() {
    while (!stopped) {
      const again = await connect();
      if (!again || stopped) break;
      await pause(5000, () => stopped);
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
    app: relay.app,
    deliver: relay.deliver,
    notify: relay.notify,
    handle
  };
}
