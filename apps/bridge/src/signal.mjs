// Reach BrowserHarness from Signal through signal-cli, the open-source Signal
// client, running on this computer with a number registered for the bot.
// Messages from the numbers you allowed become tasks; the result comes back
// as a reply. Nothing leaves your computer except through Signal itself.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { clipMessage, createChatRelay, pause } from "./chat-relay.mjs";

const MAX_MESSAGE = 3900;

/** A phone number with country code, or a Signal account id. */
export const SIGNAL_ID = /^(\+\d{6,15}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Runs signal-cli once and returns what it printed. */
export function runSignalCli(command, args, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", (error) =>
      reject(new Error(error.code === "ENOENT" ? `${command} was not found. Install signal-cli first (see the Signal guide).` : error.message))
    );
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `${command} stopped (${code})`));
    });
  });
}

/** The sender and task in a signal-cli notification, or null. */
export function signalMessage(notification) {
  if (notification?.method !== "receive") return null;
  const envelope = notification.params?.envelope || notification.params?.result?.envelope;
  const data = envelope?.dataMessage;
  // Group messages are left alone: the bot answers people one to one.
  if (!data || typeof data.message !== "string" || data.groupInfo || data.groupV2) return null;
  const from = envelope.sourceNumber || envelope.source || envelope.sourceUuid;
  if (!from) return null;
  return { from: String(from), name: envelope.sourceName || "", text: data.message };
}

export function createSignalRelay({ number, command = "signal-cli", allowedUserIds = [], runTask, log = () => undefined }) {
  let child = null;
  let stopped = false;
  let nextId = 1;

  const send = async (recipient, text) => {
    if (!child?.stdin.writable) throw new Error("signal-cli is not running");
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: String(nextId++), method: "send", params: { recipient: [recipient], message: clipMessage(text, MAX_MESSAGE) } })}\n`
    );
  };
  const relay = createChatRelay({ app: "signal", allowedUserIds, runTask, send });

  async function handle(notification) {
    const message = signalMessage(notification);
    if (!message) return;
    await relay.handle({ chatId: message.from, userId: message.from, userName: message.name, text: message.text });
  }

  /** One signal-cli process; resolves when it stops. */
  function run() {
    return new Promise((resolve) => {
      child = spawn(command, ["-a", number, "jsonRpc"], { shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"] });
      createInterface({ input: child.stdout }).on("line", (line) => {
        let notification;
        try {
          notification = JSON.parse(line);
        } catch {
          return;
        }
        handle(notification).catch((error) => log(`signal: ${error.message}`));
      });
      createInterface({ input: child.stderr }).on("line", (line) => log(`signal: ${line}`));
      child.on("error", (error) => {
        log(`signal: ${error.code === "ENOENT" ? `${command} was not found` : error.message}`);
      });
      child.on("close", () => resolve());
    });
  }

  async function loop() {
    while (!stopped) {
      await run();
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
      child?.kill();
    },
    deliver: relay.deliver,
    handle
  };
}
