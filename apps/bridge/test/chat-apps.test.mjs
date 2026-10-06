import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { CHAT_HELP, createChatRelay } from "../src/chat-relay.mjs";
import { createDiscordRelay, discordTask } from "../src/discord.mjs";
import { createSlackRelay, slackTask } from "../src/slack.mjs";
import { createSignalRelay, signalMessage, SIGNAL_ID } from "../src/signal.mjs";

const until = async (check, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
};

const acceptingTasks = (tasks) => async (text, meta) => {
  tasks.push({ text, meta });
  return { ok: true, id: `task-${tasks.length}` };
};

test("every chat app: strangers get the allow command, allowed people get tasks and results", async () => {
  const sent = [];
  const tasks = [];
  const relay = createChatRelay({
    app: "slack",
    allowedUserIds: ["U42"],
    send: async (chatId, text) => sent.push({ chatId, text }),
    runTask: acceptingTasks(tasks)
  });
  await relay.handle({ chatId: "D1", userId: "U7", text: "delete everything" });
  assert.equal(tasks.length, 0);
  assert.match(sent.at(-1).text, /private/);
  assert.match(sent.at(-1).text, /this Slack account/);
  assert.match(sent.at(-1).text, /browserharness-bridge slack allow U7/);

  await relay.handle({ chatId: "D2", userId: "U42", text: "help" });
  assert.equal(sent.at(-1).text, CHAT_HELP);

  await relay.handle({ chatId: "D2", userId: "U42", userName: "Ada", text: "  check my inbox " });
  assert.deepEqual(tasks, [{ text: "check my inbox", meta: { from: "slack", user: "Ada" } }]);
  assert.deepEqual(sent.at(-1), { chatId: "D2", text: "On it: check my inbox" });

  assert.equal(await relay.deliver("task-1", { status: "worked", message: "3 invoices" }), true);
  assert.deepEqual(sent.at(-1), { chatId: "D2", text: "Done\n\n3 invoices" });
  assert.equal(await relay.deliver("task-1", { status: "worked", message: "again" }), false);
});

test("Discord: answers direct messages and mentions, never other bots or plain server chatter", () => {
  const botId = "999";
  assert.equal(discordTask({ author: { id: "1" }, content: "check my inbox" }, botId), "check my inbox");
  assert.equal(discordTask({ guild_id: "g", author: { id: "1" }, content: "hello all", mentions: [] }, botId), null);
  assert.equal(
    discordTask({ guild_id: "g", author: { id: "1" }, content: "<@999> check prices", mentions: [{ id: "999" }] }, botId),
    "check prices"
  );
  assert.equal(discordTask({ author: { id: "2", bot: true }, content: "On it" }, botId), null);
});

test("Discord: a message through the gateway becomes a task and the result goes back", async () => {
  const gateway = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => gateway.once("listening", resolve));
  const identified = [];
  let client = null;
  gateway.on("connection", (socket) => {
    client = socket;
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
    socket.on("message", (raw) => {
      const packet = JSON.parse(String(raw));
      if (packet.op === 2) {
        identified.push(packet.d);
        socket.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: { user: { id: "999", username: "harness" } } }));
      }
    });
  });
  const posted = [];
  const fetchImpl = async (url, init) => {
    posted.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: "m1" }));
  };
  const tasks = [];
  const relay = createDiscordRelay({
    token: "bot-token",
    allowedUserIds: ["42"],
    apiBase: "http://discord.test/api",
    gatewayUrl: `ws://127.0.0.1:${gateway.address().port}`,
    fetchImpl,
    runTask: acceptingTasks(tasks)
  });
  relay.start();
  try {
    await until(() => identified.length);
    assert.equal(identified[0].token, "bot-token");
    // Server messages and DMs only: no special permission needed.
    assert.equal(identified[0].intents, (1 << 9) | (1 << 12));
    client.send(
      JSON.stringify({ op: 0, s: 2, t: "MESSAGE_CREATE", d: { channel_id: "c1", guild_id: "g1", author: { id: "42", username: "ada" }, content: "<@999> find red shoes", mentions: [{ id: "999" }] } })
    );
    await until(() => posted.length);
    assert.deepEqual(tasks, [{ text: "find red shoes", meta: { from: "discord", user: "ada" } }]);
    assert.equal(posted[0].url, "http://discord.test/api/channels/c1/messages");
    assert.equal(posted[0].auth, "Bot bot-token");
    assert.equal(posted[0].body.content, "On it: find red shoes");
    await relay.deliver("task-1", { status: "needs you", message: "Approve the payment at your computer." });
    assert.equal(posted.at(-1).body.content, "Needs you\n\nApprove the payment at your computer.");
  } finally {
    relay.stop();
    gateway.close();
  }
});

test("Slack: answers DMs and mentions, skips bots, edits and replays", async () => {
  assert.equal(slackTask({ type: "message", channel_type: "im", user: "U1", text: "hi there" }), "hi there");
  assert.equal(slackTask({ type: "message", channel_type: "channel", user: "U1", text: "hi" }), null);
  assert.equal(slackTask({ type: "app_mention", user: "U1", text: "<@UBOT> check prices" }), "check prices");
  assert.equal(slackTask({ type: "message", channel_type: "im", bot_id: "B1", text: "On it" }), null);
  assert.equal(slackTask({ type: "message", channel_type: "im", subtype: "message_changed", text: "x" }), null);
});

test("Slack: a Socket Mode event is acknowledged, run once, and answered", async () => {
  const socketServer = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => socketServer.once("listening", resolve));
  const acks = [];
  let client = null;
  socketServer.on("connection", (socket) => {
    client = socket;
    socket.send(JSON.stringify({ type: "hello" }));
    socket.on("message", (raw) => acks.push(JSON.parse(String(raw)).envelope_id));
  });
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = url.split("/").pop();
    calls.push({ method, auth: init.headers.authorization, body: JSON.parse(init.body) });
    const result = method === "apps.connections.open" ? { ok: true, url: `ws://127.0.0.1:${socketServer.address().port}` } : { ok: true };
    return new Response(JSON.stringify(result));
  };
  const tasks = [];
  const relay = createSlackRelay({
    botToken: "xoxb-1",
    appToken: "xapp-1",
    allowedUserIds: ["U42"],
    apiBase: "http://slack.test/api",
    fetchImpl,
    runTask: acceptingTasks(tasks)
  });
  relay.start();
  try {
    await until(() => client);
    assert.equal(calls[0].auth, "Bearer xapp-1");
    const event = { type: "message", channel_type: "im", channel: "D9", user: "U42", text: "check my inbox", ts: "1.1", client_msg_id: "abc" };
    client.send(JSON.stringify({ type: "events_api", envelope_id: "e1", payload: { event } }));
    client.send(JSON.stringify({ type: "events_api", envelope_id: "e2", payload: { event } }));
    await until(() => calls.some((call) => call.method === "chat.postMessage") && acks.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(acks, ["e1", "e2"]);
    assert.equal(tasks.length, 1);
    const reply = calls.find((call) => call.method === "chat.postMessage");
    assert.deepEqual(reply.body, { channel: "D9", text: "On it: check my inbox" });
    assert.equal(reply.auth, "Bearer xoxb-1");
  } finally {
    relay.stop();
    socketServer.close();
  }
});

test("Signal: reads direct messages from signal-cli and replies through it", async () => {
  assert.ok(SIGNAL_ID.test("+15551234567"));
  assert.ok(!SIGNAL_ID.test("5551234567"));
  assert.deepEqual(
    signalMessage({ method: "receive", params: { envelope: { sourceNumber: "+15550001111", sourceName: "Ada", dataMessage: { message: "find flights" } } } }),
    { from: "+15550001111", name: "Ada", text: "find flights" }
  );
  assert.equal(signalMessage({ method: "receive", params: { envelope: { sourceNumber: "+1", dataMessage: { message: "hi", groupInfo: { groupId: "g" } } } } }), null);
  assert.equal(signalMessage({ method: "receive", params: { envelope: { sourceNumber: "+1", typingMessage: {} } } }), null);

  // A stand-in for signal-cli: prints one message, then records what it is asked to send.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bh-signal-"));
  const sentFile = path.join(dir, "sent.jsonl");
  const fake = path.join(dir, "signal-cli");
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(path.join(dir, "args.json"))}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ jsonrpc: "2.0", method: "receive", params: { envelope: { sourceNumber: "+15550001111", sourceName: "Ada", dataMessage: { message: "find flights to Goa" } } } }));
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => fs.appendFileSync(${JSON.stringify(sentFile)}, line + "\\n"));
`
  );
  fs.chmodSync(fake, 0o755);
  const tasks = [];
  const relay = createSignalRelay({ number: "+15559998888", command: fake, allowedUserIds: ["+15550001111"], runTask: acceptingTasks(tasks) });
  relay.start();
  try {
    const sent = () => (fs.existsSync(sentFile) ? fs.readFileSync(sentFile, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
    await until(() => sent().length);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "args.json"), "utf8")), ["-a", "+15559998888", "jsonRpc"]);
    assert.deepEqual(tasks, [{ text: "find flights to Goa", meta: { from: "signal", user: "Ada" } }]);
    assert.equal(sent()[0].method, "send");
    assert.deepEqual(sent()[0].params, { recipient: ["+15550001111"], message: "On it: find flights to Goa" });
    await relay.deliver("task-1", { status: "failed", message: "The site was down." });
    await until(() => sent().length === 2);
    assert.equal(sent()[1].params.message, "Didn't finish\n\nThe site was down.");
  } finally {
    relay.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("every chat app: scheduled results reach each allowed account, and quick answers come back at once", async () => {
  const sent = [];
  const relay = createChatRelay({
    app: "telegram",
    allowedUserIds: ["42", "43"],
    send: async (chatId, text) => sent.push({ chatId, text }),
    runTask: async () => ({ ok: true, id: "s1", reply: "Scheduled: check prices" })
  });
  assert.equal(relay.app, "telegram");
  assert.equal(await relay.notify("Done: check prices\n\nGold is up"), 2);
  assert.deepEqual(sent.map((item) => item.chatId), ["42", "43"]);

  await relay.handle({ chatId: 9, userId: "42", text: "/schedule every day at 8am check prices" });
  assert.deepEqual(sent.at(-1), { chatId: 9, text: "Scheduled: check prices" });
  // Nothing is waiting for a later result.
  assert.equal(await relay.deliver("s1", { status: "worked", message: "x" }), false);
});

test("Discord: a scheduled result opens a direct message with the person first", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(url.endsWith("/users/@me/channels") ? { id: "dm-42" } : { id: "m" }));
  };
  const relay = createDiscordRelay({ token: "t", allowedUserIds: ["42"], apiBase: "http://d.test", fetchImpl, runTask: async () => ({ ok: false }) });
  await relay.notify("Done: check prices");
  assert.deepEqual(calls[0], { url: "http://d.test/users/@me/channels", body: { recipient_id: "42" } });
  assert.deepEqual(calls[1], { url: "http://d.test/channels/dm-42/messages", body: { content: "Done: check prices" } });
});
