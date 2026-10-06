// Reach BrowserHarness from Matrix (Element and other apps): a bot account
// joins the rooms that people you allowed invite it to, and turns their
// messages into tasks. Encrypted rooms can't be read by the bot, so its rooms
// must have encryption off.
import { clipMessage, createChatRelay, pause } from "./chat-relay.mjs";
import { downloadVoice } from "./voice.mjs";

const MAX_MESSAGE = 3900;

export function matrixApi({ homeserver, token, fetchImpl = globalThis.fetch }) {
  const base = `${homeserver.replace(/\/+$/, "")}/_matrix/client/v3`;
  let txn = Date.now();
  const call = async (method, pathname, body, timeoutMs = 15_000) => {
    const response = await fetchImpl(`${base}${pathname}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.error || `Matrix ${pathname.split("?")[0]} failed (${response.status})`);
    return json;
  };
  const auth = { authorization: `Bearer ${token}` };
  return {
    /** Downloads an mxc:// file, trying the newer signed-in address first. */
    download: async (mxc, { type, name }) => {
      const [, serverName, mediaId] = /^mxc:\/\/([^/]+)\/([^/?#]+)$/.exec(String(mxc)) || [];
      if (!serverName) throw new Error("it has no file");
      const root = homeserver.replace(/\/+$/, "");
      const where = `${encodeURIComponent(serverName)}/${encodeURIComponent(mediaId)}`;
      try {
        return await downloadVoice(`${root}/_matrix/client/v1/media/download/${where}`, { headers: auth, type, name, fetchImpl });
      } catch (error) {
        if (!/\((400|404)\)/.test(error.message)) throw error;
        return downloadVoice(`${root}/_matrix/media/v3/download/${where}`, { headers: auth, type, name, fetchImpl });
      }
    },
    whoami: () => call("GET", "/account/whoami"),
    sync: (since, timeoutMs) =>
      call("GET", `/sync?timeout=${timeoutMs}${since ? `&since=${encodeURIComponent(since)}` : ""}`, undefined, timeoutMs + 15_000),
    join: (roomId) => call("POST", `/rooms/${encodeURIComponent(roomId)}/join`, {}),
    createDm: (userId) => call("POST", "/createRoom", { is_direct: true, invite: [userId], preset: "trusted_private_chat" }),
    sendMessage: (roomId, text) =>
      call("PUT", `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/bh${txn++}`, { msgtype: "m.text", body: clipMessage(text, MAX_MESSAGE) })
  };
}

/** Text messages from other people in a sync response, oldest first. */
export function matrixMessages(sync, botId) {
  const out = [];
  for (const [roomId, room] of Object.entries(sync?.rooms?.join || {})) {
    for (const event of room.timeline?.events || []) {
      if (event.type !== "m.room.message" || event.sender === botId) continue;
      if (event.content?.msgtype === "m.audio" && typeof event.content.url === "string") {
        out.push({ roomId, userId: event.sender, text: "", audio: { url: event.content.url, type: event.content.info?.mimetype || "audio/ogg", name: event.content.body || "voice.ogg" } });
        continue;
      }
      if (event.content?.msgtype !== "m.text" || typeof event.content.body !== "string") continue;
      out.push({ roomId, userId: event.sender, text: event.content.body });
    }
  }
  return out;
}

/** Rooms people invited the bot to, with who invited it. */
export function matrixInvites(sync, botId) {
  return Object.entries(sync?.rooms?.invite || {}).map(([roomId, room]) => ({
    roomId,
    inviter: (room.invite_state?.events || []).find(
      (event) => event.type === "m.room.member" && event.state_key === botId && event.content?.membership === "invite"
    )?.sender
  }));
}

export function createMatrixRelay({ homeserver, token, botId = "", allowedUserIds = [], fetchImpl = globalThis.fetch, runTask, transcribe = null, pollTimeoutMs = 30_000, log = () => undefined }) {
  const api = matrixApi({ homeserver, token, fetchImpl });
  const allowed = new Set(allowedUserIds.map(String));
  const roomFor = new Map();
  let self = botId;
  let stopped = false;
  const relay = createChatRelay({
    app: "matrix",
    allowedUserIds,
    runTask,
    transcribe,
    send: (roomId, text) => api.sendMessage(roomId, text),
    targetFor: async (userId) => {
      if (!roomFor.has(userId)) roomFor.set(userId, (await api.createDm(userId)).room_id);
      return roomFor.get(userId);
    }
  });

  async function handleSync(sync) {
    // Only invites from allowed people are accepted; strangers are ignored.
    for (const invite of matrixInvites(sync, self)) {
      if (invite.inviter && allowed.has(invite.inviter)) {
        await api.join(invite.roomId).catch((error) => log(`matrix: ${error.message}`));
        roomFor.set(invite.inviter, invite.roomId);
      }
    }
    for (const message of matrixMessages(sync, self)) {
      if (allowed.has(message.userId)) roomFor.set(message.userId, message.roomId);
      const { audio } = message;
      await relay
        .handle({ chatId: message.roomId, userId: message.userId, text: message.text, voice: audio ? () => api.download(audio.url, audio) : null })
        .catch((error) => log(`matrix: ${error.message}`));
    }
  }

  async function loop() {
    let since = "";
    while (!stopped) {
      try {
        if (!self) self = (await api.whoami()).user_id;
        // The first sync only marks where "now" is, so old messages never run as tasks.
        if (!since) {
          since = (await api.sync("", 0)).next_batch;
          continue;
        }
        const sync = await api.sync(since, pollTimeoutMs);
        since = sync.next_batch || since;
        await handleSync(sync);
      } catch (error) {
        if (stopped) break;
        log(`matrix: ${error instanceof Error ? error.message : String(error)}`);
        if (/M_UNKNOWN_TOKEN|401/.test(String(error?.message))) break;
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
    app: relay.app,
    deliver: relay.deliver,
    allow(ids) {
      allowed.clear();
      for (const id of ids) allowed.add(String(id));
      relay.allow(ids);
    },
    notify: relay.notify,
    handleSync
  };
}
