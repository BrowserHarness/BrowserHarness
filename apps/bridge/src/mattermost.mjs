// Reach BrowserHarness from Mattermost: a bot account on your Mattermost
// server answers your direct messages, or an @mention in a channel, and only
// for the people you allowed on this computer.
import { WebSocket } from "ws";
import { clipMessage, createChatRelay, pause } from "./chat-relay.mjs";
import { downloadVoice } from "./voice.mjs";

const MAX_MESSAGE = 3900;

export function mattermostApi({ server, token, fetchImpl = globalThis.fetch }) {
  const base = server.replace(/\/+$/, "");
  const call = async (method, pathname, body) => {
    const response = await fetchImpl(`${base}/api/v4${pathname}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000)
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.message || `Mattermost ${pathname} failed (${response.status})`);
    return json;
  };
  return {
    getMe: () => call("GET", "/users/me"),
    directChannel: (botId, userId) => call("POST", "/channels/direct", [botId, userId]),
    fileUrl: (fileId) => `${base}/api/v4/files/${encodeURIComponent(fileId)}`,
    sendMessage: (channelId, text) => call("POST", "/posts", { channel_id: channelId, message: clipMessage(text, MAX_MESSAGE) }),
    socketUrl: () => `${base.replace(/^http/, "ws")}/api/v4/websocket`
  };
}

/** The task in a "posted" event, or null when the bot should stay quiet. */
export function mattermostTask(event, botId, botName = "") {
  if (event?.event !== "posted") return null;
  let post;
  try {
    post = JSON.parse(event.data?.post || "{}");
  } catch {
    return null;
  }
  if (!post.user_id || post.user_id === botId || post.type || typeof post.message !== "string") return null;
  if (event.data?.channel_type !== "D") {
    let mentions = [];
    try {
      mentions = JSON.parse(event.data?.mentions || "[]");
    } catch {
      mentions = [];
    }
    if (!mentions.includes(botId)) return null;
  }
  const text = botName ? post.message.replace(new RegExp(`@${botName}\\b`, "gi"), "").trim() : post.message;
  const audio = (post.metadata?.files || []).find((file) => String(file.mime_type || "").startsWith("audio/")) || null;
  return { channelId: post.channel_id, userId: post.user_id, text, ...(audio ? { audio } : {}) };
}

export function createMattermostRelay({ server, token, botId: knownBotId = "", botName = "", allowedUserIds = [], fetchImpl = globalThis.fetch, runTask, transcribe = null, log = () => undefined }) {
  const api = mattermostApi({ server, token, fetchImpl });
  let botId = knownBotId;
  let name = botName;
  let socket = null;
  let stopped = false;
  const relay = createChatRelay({
    app: "mattermost",
    allowedUserIds,
    runTask,
    transcribe,
    send: (channelId, text) => api.sendMessage(channelId, text),
    targetFor: async (userId) => (await api.directChannel(botId, userId)).id
  });

  async function handle(event) {
    const message = mattermostTask(event, botId, name);
    if (!message) return;
    const { audio } = message;
    await relay.handle({
      chatId: message.channelId,
      userId: message.userId,
      text: message.text,
      voice: audio?.id
        ? () => downloadVoice(api.fileUrl(audio.id), { headers: { authorization: `Bearer ${token}` }, type: audio.mime_type, name: audio.name || "voice.m4a", fetchImpl })
        : null
    });
  }

  async function connect() {
    if (!botId) {
      try {
        const me = await api.getMe();
        botId = me.id;
        name = me.username;
      } catch (error) {
        log(`mattermost: ${error.message}`);
        return !/401|403|invalid|expired/i.test(error.message);
      }
    }
    return new Promise((resolve) => {
      socket = new WebSocket(api.socketUrl(), { headers: { authorization: `Bearer ${token}` } });
      socket.on("open", () => socket.send(JSON.stringify({ seq: 1, action: "authentication_challenge", data: { token } })));
      socket.on("message", (raw) => {
        let event;
        try {
          event = JSON.parse(String(raw));
        } catch {
          return;
        }
        handle(event).catch((error) => log(`mattermost: ${error.message}`));
      });
      socket.on("error", (error) => log(`mattermost: ${error.message}`));
      socket.on("close", () => resolve(true));
    });
  }

  async function loop() {
    while (!stopped) {
      const again = await connect();
      if (!again) {
        log("mattermost: the bot was turned away. Check it with: browserharness-bridge mattermost setup --server <url> --token <token>");
        break;
      }
      if (stopped) break;
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
    allow: relay.allow,
    notify: relay.notify,
    handle
  };
}
