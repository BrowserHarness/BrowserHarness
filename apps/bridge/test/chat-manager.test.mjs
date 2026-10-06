import assert from "node:assert/strict";
import test from "node:test";
import { createChatManager } from "../src/chat-manager.mjs";
import { createChatRelay, waitingStrangers } from "../src/chat-relay.mjs";

/** A Telegram-like app whose bots are recorded instead of connecting anywhere. */
function setup() {
  let saved = { token: "pairing", telegram: undefined };
  const bots = [];
  const inputs = [];
  const tasks = [];
  const specs = {
    telegram: {
      idPattern: /^\d+$/,
      idHint: "your Telegram user id",
      async setup(current, input) {
        inputs.push(input);
        if (input.token !== "good-token") throw Object.assign(new Error("Unauthorized"), { code: "TELEGRAM_401" });
        return { settings: { token: input.token, bot: "my_bot" }, report: { bot: "@my_bot", next: "Send @my_bot a message." } };
      }
    }
  };
  const manager = createChatManager({
    specs,
    load: async () => structuredClone(saved),
    save: async (next) => {
      saved = structuredClone(next);
    },
    createApp: (app, config) => {
      if (!config[app]?.token) return null;
      const relay = createChatRelay({ app, allowedUserIds: config[app].allowed_user_ids, send: async () => undefined, runTask: async (text) => (tasks.push(text), { ok: true, id: "t" }) });
      const bot = { ...relay, token: config[app].token, started: false, stopped: false, start() { bot.started = true; }, stop() { bot.stopped = true; } };
      bots.push(bot);
      return bot;
    },
    isSetUp: (current) => Boolean(current.token)
  });
  return { manager, bots, inputs, tasks, saved: () => saved };
}

test("chat apps are set up from Settings: checked, saved, started, and tokens never sent back", async () => {
  const { manager, bots, inputs, saved } = setup();
  const before = await manager.handle("status");
  assert.equal(before.apps.telegram.set_up, false);

  await assert.rejects(manager.handle("setup", { app: "telegram", token: "typo" }), { code: "TELEGRAM_401" });
  assert.equal(saved().telegram, undefined, "a token that doesn't work is not saved");

  const done = await manager.handle("setup", { app: "telegram", token: " good-token ", command: "/tmp/evil" });
  assert.equal(inputs.at(-1).token, "good-token", "spaces around a pasted token are dropped");
  assert.equal(inputs.at(-1).command, undefined, "Settings can't choose a program to run");
  assert.equal(done.set_up, true);
  assert.equal(done.running, true);
  assert.equal(done.bot, "@my_bot");
  assert.equal(done.next, "Send @my_bot a message.");
  assert.equal(saved().telegram.token, "good-token");
  assert.equal(bots.at(-1).started, true);
  assert.doesNotMatch(JSON.stringify(await manager.handle("status")), /good-token/);
  assert.deepEqual(manager.relays().map((relay) => relay.app), ["telegram"]);
});

test("a stranger who messages the bot can be allowed with one press, and removed again", async () => {
  const { manager, bots, tasks, saved } = setup();
  await manager.handle("setup", { app: "telegram", token: "good-token" });
  const bot = bots.at(-1);
  await bot.handle({ chatId: 1, userId: 4242, userName: "Grandma", text: "hello" });
  let status = (await manager.handle("status")).apps.telegram;
  assert.deepEqual(status.waiting.map((entry) => [entry.id, entry.name]), [["4242", "Grandma"]]);

  await assert.rejects(manager.handle("allow", { app: "telegram", id: "not a number" }), { code: "BAD_ACCOUNT_ID" });
  status = await manager.handle("allow", { app: "telegram", id: "4242", name: "Grandma" });
  assert.deepEqual(status.allowed, [{ id: "4242", name: "Grandma" }]);
  assert.deepEqual(status.waiting, []);
  assert.deepEqual(saved().telegram.allowed_user_ids, ["4242"]);
  assert.equal(bots.length, 1, "allowing someone doesn't restart the bot");

  // The running bot takes the new person at once.
  await bot.handle({ chatId: 1, userId: 4242, text: "check my inbox" });
  assert.deepEqual(tasks, ["check my inbox"]);
  status = await manager.handle("remove", { app: "telegram", id: "4242" });
  assert.deepEqual(status.allowed, []);
  assert.deepEqual(saved().telegram.allowed_user_ids, []);
  await bot.handle({ chatId: 1, userId: 4242, text: "again" });
  assert.deepEqual(tasks, ["check my inbox"], "a removed person can't start tasks");
});

test("turning a chat app off stops its bot, forgets its token and who was waiting", async () => {
  const { manager, bots, saved } = setup();
  await manager.handle("setup", { app: "telegram", token: "good-token" });
  await bots.at(-1).handle({ chatId: 1, userId: 99, text: "hi" });
  assert.equal(waitingStrangers("telegram").length > 0, true);
  const status = await manager.handle("off", { app: "telegram" });
  assert.equal(status.set_up, false);
  assert.equal(status.running, false);
  assert.equal(bots.at(-1).stopped, true);
  assert.equal(saved().telegram, undefined);
  assert.deepEqual(waitingStrangers("telegram"), []);
  await assert.rejects(manager.handle("allow", { app: "telegram", id: "99" }), { code: "CHAT_APP_NOT_SET_UP" });
  await assert.rejects(manager.handle("setup", { app: "__proto__" }), { code: "UNKNOWN_CHAT_APP" });
});
