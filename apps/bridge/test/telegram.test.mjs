import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramRelay, TELEGRAM_HELP } from "../src/telegram.mjs";

function fakeTelegram() {
  const sent = [];
  const fetchImpl = async (url, init) => {
    const method = url.split("/").pop();
    const body = JSON.parse(init.body);
    if (method === "sendMessage") sent.push(body);
    return new Response(JSON.stringify({ ok: true, result: method === "getUpdates" ? [] : { message_id: 1 } }));
  };
  return { sent, fetchImpl };
}

const message = (userId, text) => ({ update_id: 1, message: { chat: { id: 500 + userId }, from: { id: userId, first_name: "Priya" }, text } });

test("Telegram relay answers only allowed people and turns their messages into tasks", async () => {
  const { sent, fetchImpl } = fakeTelegram();
  const tasks = [];
  const relay = createTelegramRelay({
    token: "123:abc",
    allowedUserIds: [42],
    fetchImpl,
    runTask: async (text, meta) => {
      tasks.push({ text, meta });
      return { ok: true, id: "task-1" };
    }
  });

  await relay.handle(message(7, "delete my account"));
  assert.equal(tasks.length, 0);
  assert.match(sent.at(-1).text, /private/);
  assert.match(sent.at(-1).text, /telegram allow 7/);

  await relay.handle(message(42, "/start"));
  assert.equal(sent.at(-1).text, TELEGRAM_HELP);

  await relay.handle(message(42, "check my inbox"));
  assert.deepEqual(tasks, [{ text: "check my inbox", meta: { from: "telegram", user: "Priya" } }]);
  assert.equal(sent.at(-1).text, "On it: check my inbox");
  assert.equal(sent.at(-1).chat_id, 542);

  assert.equal(await relay.deliver("task-1", { status: "needs you", message: "Approve the payment at your computer." }), true);
  assert.deepEqual(sent.at(-1), { chat_id: 542, text: "Needs you\n\nApprove the payment at your computer." });
  assert.equal(await relay.deliver("task-1", { status: "worked", message: "again" }), false);
});

test("Telegram relay says when Chrome cannot take the task", async () => {
  const { sent, fetchImpl } = fakeTelegram();
  const relay = createTelegramRelay({
    token: "123:abc",
    allowedUserIds: ["42"],
    fetchImpl,
    runTask: async () => ({ ok: false, error: { message: "BrowserHarness extension is not connected" } })
  });
  await relay.handle(message(42, "check my inbox"));
  assert.equal(sent.at(-1).text, "I couldn't start that: BrowserHarness extension is not connected");
});
