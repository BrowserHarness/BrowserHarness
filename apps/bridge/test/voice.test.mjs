import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createChatRelay, VOICE_OFF } from "../src/chat-relay.mjs";
import { createTranscriber, silentWav, voiceServiceUrl } from "../src/voice.mjs";
import { createTelegramRelay } from "../src/telegram.mjs";
import { slackAudio, slackTask } from "../src/slack.mjs";
import { mattermostTask } from "../src/mattermost.mjs";
import { createMatrixRelay, matrixMessages } from "../src/matrix.mjs";
import { createSignalRelay, signalAttachmentPath, signalMessage } from "../src/signal.mjs";

const acceptingTasks = (tasks) => async (text, meta) => {
  tasks.push({ text, meta });
  return { ok: true, id: `task-${tasks.length}` };
};

test("voice: sends the note to the chosen speech-to-text service and returns its words", async () => {
  const calls = [];
  const transcribe = createTranscriber({
    url: "https://stt.example.test/v1/",
    model: "my-model",
    apiKey: "k",
    language: "hi",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ text: "  check gold prices " }));
    }
  });
  assert.equal(await transcribe({ data: new Uint8Array([1, 2, 3]), type: "audio/ogg", name: "voice.oga" }), "check gold prices");
  assert.equal(calls[0].url, "https://stt.example.test/v1/audio/transcriptions");
  assert.equal(calls[0].init.headers.authorization, "Bearer k");
  const form = calls[0].init.body;
  assert.equal(form.get("model"), "my-model");
  assert.equal(form.get("language"), "hi");
  assert.equal(form.get("file").size, 3);
  assert.equal(form.get("file").name, "voice.oga");

  const refusing = createTranscriber({ url: "http://127.0.0.1:9/v1", model: "m", fetchImpl: async () => new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 404 }) });
  await assert.rejects(refusing({ data: new Uint8Array([1]) }), /model not found/);
  await assert.rejects(refusing({ data: new Uint8Array() }), /empty/);

  // No model is ever picked for you, and voice notes never travel over plain http to another computer.
  assert.throws(() => createTranscriber({ url: "https://stt.example.test/v1" }), /--model/);
  assert.throws(() => voiceServiceUrl("http://stt.example.test/v1"), /https/);
  assert.equal(voiceServiceUrl("http://localhost:8000/v1/"), "http://localhost:8000/v1");

  const wav = silentWav();
  assert.equal(Buffer.from(wav.data.slice(0, 4)).toString(), "RIFF");
  assert.equal(wav.data.byteLength, 44 + 32_000);
});

test("voice: only allowed people's voice notes are downloaded, and the bot says what it heard", async () => {
  const sent = [];
  const tasks = [];
  let downloads = 0;
  const voice = async () => {
    downloads += 1;
    return { data: new Uint8Array([1]), type: "audio/ogg", name: "v.ogg" };
  };
  const relay = createChatRelay({
    app: "telegram",
    allowedUserIds: ["7"],
    runTask: acceptingTasks(tasks),
    send: async (chatId, text) => sent.push(text),
    transcribe: async (audio) => (audio.data.byteLength ? "find flights to Goa" : "")
  });
  await relay.handle({ chatId: 1, userId: "99", voice });
  assert.equal(downloads, 0);
  assert.match(sent.at(-1), /private/);

  await relay.handle({ chatId: 1, userId: "7", userName: "Ada", voice });
  assert.equal(downloads, 1);
  assert.deepEqual(tasks, [{ text: "find flights to Goa", meta: { from: "telegram", user: "Ada" } }]);
  assert.equal(sent.at(-1), "On it (from your voice note): find flights to Goa");

  // Text wins over an attached clip; a silent note or a failing service is explained, not run.
  await relay.handle({ chatId: 1, userId: "7", text: "check prices", voice });
  assert.equal(downloads, 1);
  assert.equal(sent.at(-1), "On it: check prices");
  await relay.handle({ chatId: 1, userId: "7", voice: async () => ({ data: new Uint8Array() }) });
  assert.match(sent.at(-1), /couldn't hear any words/);
  await relay.handle({ chatId: 1, userId: "7", voice: async () => Promise.reject(new Error("couldn't download it (404)")) });
  assert.equal(sent.at(-1), "I couldn't make out that voice note: couldn't download it (404)");
  assert.equal(tasks.length, 2);

  const off = createChatRelay({ app: "telegram", allowedUserIds: ["7"], runTask: acceptingTasks([]), send: async (chatId, text) => sent.push(text) });
  await off.handle({ chatId: 1, userId: "7", voice });
  assert.equal(sent.at(-1), VOICE_OFF);
});

test("voice: a Telegram voice message is fetched through the Bot API and runs as a task", async () => {
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push(url);
    if (url.endsWith("/getFile")) {
      assert.deepEqual(JSON.parse(init.body), { file_id: "F1" });
      return new Response(JSON.stringify({ ok: true, result: { file_path: "voice/file_1.oga" } }));
    }
    if (url.includes("/file/bot")) return new Response(new Uint8Array([9, 9]), { headers: { "content-type": "audio/ogg" } });
    return new Response(JSON.stringify({ ok: true, result: {} }));
  };
  const heard = [];
  const tasks = [];
  const relay = createTelegramRelay({
    token: "T",
    apiBase: "http://tg.test",
    allowedUserIds: ["7"],
    fetchImpl,
    runTask: acceptingTasks(tasks),
    transcribe: async (audio) => {
      heard.push(audio);
      return "check the weather";
    }
  });
  await relay.handle({ update_id: 1, message: { chat: { id: 5 }, from: { id: 7, first_name: "Ada" }, voice: { file_id: "F1", mime_type: "audio/ogg", duration: 2 } } });
  assert.deepEqual(urls.slice(0, 2), ["http://tg.test/botT/getFile", "http://tg.test/file/botT/voice/file_1.oga"]);
  assert.equal(heard[0].name, "file_1.oga");
  assert.deepEqual([...heard[0].data], [9, 9]);
  assert.equal(tasks[0].text, "check the weather");
});

test("voice: Slack, Mattermost, Matrix and Signal voice notes are recognised", async () => {
  const clip = { channel: "D1", user: "U1", type: "message", channel_type: "im", subtype: "file_share", text: "", files: [{ subtype: "slack_audio", mimetype: "audio/webm", url_private_download: "https://files.slack.test/a" }] };
  assert.equal(slackTask(clip), "");
  assert.equal(slackAudio(clip).url_private_download, "https://files.slack.test/a");
  assert.equal(slackTask({ ...clip, subtype: "message_changed" }), null);
  assert.equal(slackAudio({ files: [{ mimetype: "image/png", url_private: "x" }] }), null);

  const bot = "b".repeat(26);
  const post = { user_id: "u".repeat(26), channel_id: "c1", message: "", metadata: { files: [{ id: "f1", mime_type: "audio/m4a", name: "a.m4a" }] } };
  assert.deepEqual(mattermostTask({ event: "posted", data: { post: JSON.stringify(post), channel_type: "D" } }, bot).audio, { id: "f1", mime_type: "audio/m4a", name: "a.m4a" });

  const sync = { rooms: { join: { "!r:hs": { timeline: { events: [{ type: "m.room.message", sender: "@ada:hs", content: { msgtype: "m.audio", body: "Voice message", url: "mxc://hs/abc", info: { mimetype: "audio/ogg" } } }] } } } } };
  assert.deepEqual(matrixMessages(sync, "@bot:hs"), [{ roomId: "!r:hs", userId: "@ada:hs", text: "", audio: { url: "mxc://hs/abc", type: "audio/ogg", name: "Voice message" } }]);
  const calls = [];
  const tasks = [];
  const matrix = createMatrixRelay({
    homeserver: "http://hs.test",
    token: "t",
    botId: "@bot:hs",
    allowedUserIds: ["@ada:hs"],
    runTask: acceptingTasks(tasks),
    transcribe: async (audio) => `${audio.data.byteLength} bytes`,
    fetchImpl: async (url, init) => {
      calls.push(url);
      // An older server without signed-in media falls back to the classic address.
      if (url.includes("/client/v1/media/")) return new Response("{}", { status: 404 });
      if (url.includes("/media/v3/download/")) return new Response(new Uint8Array([1, 2, 3, 4]));
      return new Response(JSON.stringify({ event_id: "$e" }));
    }
  });
  await matrix.handleSync(sync);
  assert.deepEqual(calls.slice(0, 2), ["http://hs.test/_matrix/client/v1/media/download/hs/abc", "http://hs.test/_matrix/media/v3/download/hs/abc"]);
  assert.equal(tasks[0].text, "4 bytes");

  const dir = await mkdtemp(path.join(os.tmpdir(), "bh-signal-"));
  try {
    await mkdir(path.join(dir, "attachments"));
    await writeFile(path.join(dir, "attachments", "att1.aac"), Buffer.from([5, 5, 5]));
    const note = { method: "receive", params: { envelope: { sourceNumber: "+15551234567", dataMessage: { message: null, attachments: [{ contentType: "audio/aac", id: "att1.aac" }] } } } };
    assert.deepEqual(signalMessage(note).audio, { contentType: "audio/aac", id: "att1.aac" });
    assert.equal(signalAttachmentPath({ id: "att1.aac" }, dir), path.join(dir, "attachments", "att1.aac"));
    assert.throws(() => signalAttachmentPath({ id: "../../etc/passwd" }, dir), /didn't save/);
    const heard = [];
    const signal = createSignalRelay({ number: "+15550000000", dataDir: dir, allowedUserIds: ["+15551234567"], runTask: acceptingTasks([]), transcribe: async (audio) => heard.push(audio) && "" });
    await signal.handle(note).catch(() => undefined);
    assert.deepEqual([...heard[0].data], [5, 5, 5]);
    assert.equal(heard[0].type, "audio/aac");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("voice: a Discord voice message in a DM is downloaded from its attachment", async () => {
  const { createDiscordRelay } = await import("../src/discord.mjs");
  const urls = [];
  const tasks = [];
  const relay = createDiscordRelay({
    token: "T",
    botId: "1",
    apiBase: "http://discord.test",
    allowedUserIds: ["42"],
    runTask: acceptingTasks(tasks),
    transcribe: async (audio) => `${audio.type} ${audio.data.byteLength}`,
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.startsWith("https://cdn.discord.test/")) return new Response(new Uint8Array([1, 2]), { headers: { "content-type": "audio/ogg" } });
      return new Response(JSON.stringify({ id: "m" }));
    }
  });
  await relay.handle({
    channel_id: "c",
    author: { id: "42", username: "ada" },
    content: "",
    flags: 8192,
    attachments: [{ url: "https://cdn.discord.test/voice-message.ogg", content_type: "audio/ogg", filename: "voice-message.ogg" }]
  });
  assert.equal(urls[0], "https://cdn.discord.test/voice-message.ogg");
  assert.equal(tasks[0].text, "audio/ogg 2");
});
