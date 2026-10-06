// Reach BrowserHarness from Signal through signal-cli, the open-source Signal
// client, running on this computer with a number registered for the bot.
// Messages from the numbers you allowed become tasks; the result comes back
// as a reply. Nothing leaves your computer except through Signal itself.
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { clipMessage, createChatRelay, pause } from "./chat-relay.mjs";
import { MAX_VOICE_BYTES } from "./voice.mjs";

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
  if (!data || data.groupInfo || data.groupV2) return null;
  const audio = (data.attachments || []).find((file) => String(file.contentType || "").startsWith("audio/")) || null;
  if (typeof data.message !== "string" && !audio) return null;
  const from = envelope.sourceNumber || envelope.source || envelope.sourceUuid;
  if (!from) return null;
  return { from: String(from), name: envelope.sourceName || "", text: data.message || "", ...(audio ? { audio } : {}) };
}

/** Where signal-cli saved a received attachment on this computer. */
export function signalAttachmentPath(attachment, dataDir = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "signal-cli")) {
  if (attachment?.file) return attachment.file;
  if (!/^[\w.-]+$/.test(String(attachment?.id || ""))) throw new Error("signal-cli didn't save it");
  return path.join(dataDir, "attachments", attachment.id);
}

export function createSignalRelay({ number, command = "signal-cli", dataDir, allowedUserIds = [], runTask, transcribe = null, log = () => undefined }) {
  let child = null;
  let stopped = false;
  let nextId = 1;

  const send = async (recipient, text) => {
    if (!child?.stdin.writable) throw new Error("signal-cli is not running");
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: String(nextId++), method: "send", params: { recipient: [recipient], message: clipMessage(text, MAX_MESSAGE) } })}\n`
    );
  };
  const relay = createChatRelay({ app: "signal", allowedUserIds, runTask, transcribe, send });

  const readVoice = async (audio) => {
    const file = signalAttachmentPath(audio, ...(dataDir ? [dataDir] : []));
    if ((await stat(file)).size > MAX_VOICE_BYTES) throw new Error("it is too long (20 MB at most)");
    return { data: new Uint8Array(await readFile(file)), type: audio.contentType, name: audio.filename || `voice.${String(audio.contentType).split("/")[1] || "aac"}` };
  };

  async function handle(notification) {
    const message = signalMessage(notification);
    if (!message) return;
    await relay.handle({
      chatId: message.from,
      userId: message.from,
      userName: message.name,
      text: message.text,
      voice: message.audio ? () => readVoice(message.audio) : null
    });
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
    app: relay.app,
    deliver: relay.deliver,
    notify: relay.notify,
    handle
  };
}
