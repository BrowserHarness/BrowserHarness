// Reach BrowserHarness by email: a mailbox for the bot (IMAP to read, SMTP to
// reply). Mail from the addresses you allowed becomes a task; the result comes
// back as a reply. Because a From line is easy to fake, a message only counts
// when your mail provider's own check (Authentication-Results) says the sender
// really is that address.
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";
import { createChatRelay, pause } from "./chat-relay.mjs";

const MAX_TASK = 4000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/** Known providers, so setup needs only an address and an app password. */
export const EMAIL_PROVIDERS = {
  "gmail.com": { imap: "imap.gmail.com:993", smtp: "smtp.gmail.com:465" },
  "googlemail.com": { imap: "imap.gmail.com:993", smtp: "smtp.gmail.com:465" },
  "fastmail.com": { imap: "imap.fastmail.com:993", smtp: "smtp.fastmail.com:465" },
  "yahoo.com": { imap: "imap.mail.yahoo.com:993", smtp: "smtp.mail.yahoo.com:465" },
  "icloud.com": { imap: "imap.mail.me.com:993", smtp: "smtp.mail.me.com:587" },
  "me.com": { imap: "imap.mail.me.com:993", smtp: "smtp.mail.me.com:587" },
  "outlook.com": { imap: "outlook.office365.com:993", smtp: "smtp.office365.com:587" },
  "hotmail.com": { imap: "outlook.office365.com:993", smtp: "smtp.office365.com:587" },
  "zoho.com": { imap: "imap.zoho.com:993", smtp: "smtp.zoho.com:465" }
};

export function providerFor(address) {
  return EMAIL_PROVIDERS[String(address).split("@")[1]?.toLowerCase() || ""] || null;
}

export function hostPort(value, fallbackPort) {
  const match = /^(.+?)(?::(\d+))?$/.exec(String(value || "").trim());
  return { host: match?.[1] || "", port: Number(match?.[2]) || fallbackPort };
}

/** Plain (unencrypted) connections are only for a mail server on this computer. */
function connect({ host, port, secure }) {
  return new Promise((resolve, reject) => {
    const plainAllowed = LOOPBACK.has(host);
    const socket =
      secure === false && plainAllowed
        ? net.connect({ host, port }, () => resolve(socket))
        : tls.connect({ host, port, servername: host }, () => resolve(socket));
    socket.setTimeout(30_000, () => socket.destroy(new Error(`${host} did not answer`)));
    socket.once("error", reject);
  });
}

/** Reads CRLF lines (and IMAP {n} literals) from a socket; replace() follows a STARTTLS upgrade. */
function lineReader(first) {
  let buffer = Buffer.alloc(0);
  let waiting = null;
  let failed = null;
  let current = null;
  const wake = () => {
    const resolve = waiting;
    waiting = null;
    resolve?.();
  };
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    wake();
  };
  const onError = (error) => {
    failed = error;
    wake();
  };
  const onClose = () => {
    failed = failed || new Error("The mail server closed the connection");
    wake();
  };
  const attach = (socket) => {
    if (current) {
      current.off("data", onData);
      current.off("error", onError);
      current.off("close", onClose);
    }
    current = socket;
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  };
  attach(first);
  const until = async (ready) => {
    while (!ready()) {
      if (failed) throw failed;
      await new Promise((resolve) => (waiting = resolve));
    }
  };
  return {
    async line() {
      await until(() => buffer.indexOf("\r\n") >= 0);
      const end = buffer.indexOf("\r\n");
      const text = buffer.subarray(0, end).toString("utf8");
      buffer = buffer.subarray(end + 2);
      return text;
    },
    async bytes(count) {
      await until(() => buffer.length >= count);
      const out = buffer.subarray(0, count);
      buffer = buffer.subarray(count);
      return out;
    },
    replace(socket) {
      attach(socket);
    }
  };
}

const quote = (value) => `"${String(value).replace(/["\\]/g, (char) => `\\${char}`)}"`;

/** A small IMAP client: log in, find new mail, fetch it, mark it read. */
export async function openImap({ host, port = 993, secure = true, user, password }) {
  const socket = await connect({ host, port, secure });
  const reader = lineReader(socket);
  let counter = 0;
  const greeting = await reader.line();
  if (!/^\* (OK|PREAUTH)/i.test(greeting)) throw new Error(`Unexpected IMAP greeting: ${greeting}`);
  const command = async (text) => {
    const tag = `b${++counter}`;
    socket.write(`${tag} ${text}\r\n`);
    const lines = [];
    const literals = [];
    for (;;) {
      let line = await reader.line();
      let literal = /\{(\d+)\}$/.exec(line);
      while (literal) {
        literals.push((await reader.bytes(Number(literal[1]))).toString("latin1"));
        const rest = await reader.line();
        line = `${line} ${rest}`;
        literal = /\{(\d+)\}$/.exec(rest);
      }
      if (line.startsWith(`${tag} `)) {
        if (!/^\S+ OK/i.test(line)) throw new Error(`IMAP: ${line.slice(tag.length + 1)}`);
        return Object.assign(lines, { literals });
      }
      lines.push(line);
    }
  };
  await command(`LOGIN ${quote(user)} ${quote(password)}`);
  return {
    async select(box = "INBOX") {
      const lines = await command(`SELECT ${quote(box)}`);
      const next = lines.map((line) => /UIDNEXT (\d+)/i.exec(line)?.[1]).find(Boolean);
      return { uidNext: Number(next) || 0 };
    },
    async unseenUids() {
      const lines = await command("UID SEARCH UNSEEN");
      return lines
        .filter((line) => /^\* SEARCH/i.test(line))
        .flatMap((line) => line.replace(/^\* SEARCH/i, "").trim().split(/\s+/))
        .filter(Boolean)
        .map(Number);
    },
    async fetch(uid) {
      const lines = await command(`UID FETCH ${uid} (BODY.PEEK[])`);
      return lines.literals[0] || "";
    },
    markSeen: (uid) => command(`UID STORE ${uid} +FLAGS (\\Seen)`),
    async close() {
      await command("LOGOUT").catch(() => undefined);
      socket.destroy();
    }
  };
}

/** A small SMTP client: log in and send one plain-text message. */
export async function sendSmtp({ host, port = 465, secure = true, user, password, from, to, subject, text, inReplyTo, checkOnly = false }) {
  // Port 587 starts plain and must upgrade with STARTTLS before the password is sent.
  const starttls = port === 587 && !(secure === false && LOOPBACK.has(host));
  let socket = starttls
    ? await new Promise((resolve, reject) => {
        const plain = net.connect({ host, port }, () => resolve(plain));
        plain.setTimeout(30_000, () => plain.destroy(new Error(`${host} did not answer`)));
        plain.once("error", reject);
      })
    : await connect({ host, port, secure });
  const reader = lineReader(socket);
  const expect = async (code) => {
    let line = await reader.line();
    while (/^\d{3}-/.test(line)) line = await reader.line();
    if (!line.startsWith(String(code))) throw new Error(`SMTP: ${line}`);
    return line;
  };
  const say = async (text, code) => {
    socket.write(`${text}\r\n`);
    return expect(code);
  };
  await expect(220);
  await say(`EHLO browserharness.local`, 250);
  if (starttls) {
    await say("STARTTLS", 220);
    const plain = socket;
    // Stop reading the plain socket before TLS takes it over.
    reader.replace(new net.Socket());
    socket = await new Promise((resolve, reject) => {
      const secured = tls.connect({ socket: plain, servername: host }, () => resolve(secured));
      secured.once("error", reject);
    });
    reader.replace(socket);
    await say(`EHLO browserharness.local`, 250);
  }
  await say(`AUTH PLAIN ${Buffer.from(`\0${user}\0${password}`).toString("base64")}`, 235);
  if (checkOnly) {
    await say("QUIT", 221).catch(() => undefined);
    socket.destroy();
    return;
  }
  await say(`MAIL FROM:<${from}>`, 250);
  await say(`RCPT TO:<${to}>`, 250);
  await say("DATA", 354);
  const encodedSubject = /^[\x20-\x7e]*$/.test(subject) ? subject : `=?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`;
  const headers = [
    `From: BrowserHarness <${from}>`,
    `To: <${to}>`,
    `Subject: ${encodedSubject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@browserharness.local>`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64"
  ];
  const body = Buffer.from(text).toString("base64").replace(/.{1,76}/g, "$&\r\n");
  await say(`${headers.join("\r\n")}\r\n\r\n${body}.`, 250);
  await say("QUIT", 221).catch(() => undefined);
  socket.destroy();
}

function decodeWords(value) {
  return value.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_all, charset, kind, data) => {
    const bytes =
      kind.toLowerCase() === "b"
        ? Buffer.from(data, "base64")
        : Buffer.from(data.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16))), "latin1");
    return decodeText(bytes, charset);
  });
}

function decodeText(bytes, charset = "utf-8") {
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

function parseHeaders(text) {
  const headers = [];
  for (const line of text.replace(/\r\n[ \t]+/g, " ").split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index > 0) headers.push([line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim()]);
  }
  return headers;
}

const header = (headers, name) => headers.find(([key]) => key === name)?.[1] || "";

function param(value, name) {
  return new RegExp(`${name}="?([^";]+)"?`, "i").exec(value)?.[1] || "";
}

/** The readable text of a MIME part (first text/plain, else text/html without tags). */
function partText(raw) {
  const split = raw.search(/\r?\n\r?\n/);
  const headers = parseHeaders(split >= 0 ? raw.slice(0, split) : raw);
  const body = split >= 0 ? raw.slice(split).replace(/^\r?\n\r?\n/, "") : "";
  const type = header(headers, "content-type") || "text/plain";
  if (/^multipart\//i.test(type)) {
    const boundary = param(type, "boundary");
    const parts = body.split(`--${boundary}`).slice(1).filter((part) => !part.startsWith("--"));
    const texts = parts.map((part) => ({ type: /content-type:\s*([^;\r\n]+)/i.exec(part)?.[1]?.toLowerCase() || "text/plain", text: partText(part.replace(/^\r?\n/, "")) }));
    return (texts.find((part) => part.type === "text/plain") || texts.find((part) => part.text))?.text || "";
  }
  const encoding = header(headers, "content-transfer-encoding").toLowerCase();
  const bytes =
    encoding === "base64"
      ? Buffer.from(body.replace(/\s+/g, ""), "base64")
      : encoding === "quoted-printable"
        ? Buffer.from(body.replace(/=\r?\n/g, "").replace(/=([0-9a-f]{2})/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16))), "latin1")
        : Buffer.from(body, "latin1");
  const text = decodeText(bytes, param(type, "charset") || "utf-8");
  return /^text\/html/i.test(type) ? text.replace(/<br\s*\/?>|<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ") : text;
}

/** Drops quoted earlier mail and signatures, keeping what the person just wrote. */
export function freshText(text) {
  const kept = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*>/.test(line)) continue;
    if (/^On .+wrote:\s*$/.test(line) || /^-- ?$/.test(line) || /^-{2,}\s*Original Message/i.test(line) || /^From: .+/.test(line)) break;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

/** Whether the provider's own check says the From address is real. */
export function senderVerified(headers, address) {
  // The topmost Authentication-Results is the receiving server's; lower ones could be forged.
  const results = header(headers, "authentication-results").toLowerCase();
  const domain = address.split("@")[1] || "";
  if (!results || !domain) return false;
  if (/\bdmarc=pass\b/.test(results) && results.includes(`header.from=${domain}`)) return true;
  const dkim = /\bdkim=pass\b[^;]*?header\.(?:d|i)=@?([a-z0-9.-]+)/.exec(results)?.[1];
  return Boolean(dkim && (domain === dkim || domain.endsWith(`.${dkim}`)));
}

/** From a raw message: who sent it, whether that is verified, and the task. */
export function parseEmail(raw) {
  const split = raw.search(/\r?\n\r?\n/);
  const headers = parseHeaders(split >= 0 ? raw.slice(0, split) : raw);
  const fromHeader = decodeWords(header(headers, "from"));
  const address = (/<([^>]+)>/.exec(fromHeader)?.[1] || fromHeader).trim().toLowerCase();
  const subject = decodeWords(header(headers, "subject")).trim();
  const body = freshText(partText(raw));
  return {
    from: address,
    name: fromHeader.replace(/<[^>]+>/, "").replace(/"/g, "").trim(),
    subject,
    messageId: header(headers, "message-id"),
    verified: senderVerified(headers, address),
    automated: /auto-(replied|generated)/i.test(header(headers, "auto-submitted")) || /bulk|list|junk/i.test(header(headers, "precedence")),
    text: (body || subject.replace(/^(re|fwd?):\s*/i, "")).slice(0, MAX_TASK)
  };
}

export function createEmailRelay({
  address,
  password,
  imap,
  smtp,
  allowedUserIds = [],
  runTask,
  pollSeconds = 30,
  log = () => undefined,
  openMailbox = openImap,
  send = sendSmtp
}) {
  const threads = new Map();
  let stopped = false;
  const sendMail = (to, text) => {
    const thread = threads.get(to);
    return send({ ...smtp, user: address, password, from: address, to, subject: thread?.subject ? `Re: ${thread.subject.replace(/^re:\s*/i, "")}` : "BrowserHarness", text, inReplyTo: thread?.messageId });
  };
  const relay = createChatRelay({
    app: "email",
    allowedUserIds: allowedUserIds.map((id) => String(id).toLowerCase()),
    runTask,
    send: (to, text) => sendMail(to, text)
  });

  async function handle(message) {
    if (!message.from || message.automated || message.from === address.toLowerCase()) return;
    if (!message.verified) {
      log(`email: ignored a message from ${message.from}: the mail provider could not confirm the sender`);
      return;
    }
    threads.set(message.from, { subject: message.subject, messageId: message.messageId });
    await relay.handle({ chatId: message.from, userId: message.from, userName: message.name, text: message.text });
  }

  async function poll(state) {
    const box = await openMailbox({ ...imap, user: address, password });
    try {
      const { uidNext } = await box.select();
      // The first look only notes where new mail starts, so old mail never runs as tasks.
      if (!state.from) state.from = uidNext;
      for (const uid of (await box.unseenUids()).filter((value) => value >= state.from)) {
        const raw = await box.fetch(uid);
        await box.markSeen(uid);
        state.from = Math.max(state.from, uid + 1);
        await handle(parseEmail(raw)).catch((error) => log(`email: ${error.message}`));
      }
    } finally {
      await box.close();
    }
  }

  async function loop() {
    const state = { from: 0 };
    while (!stopped) {
      try {
        await poll(state);
      } catch (error) {
        log(`email: ${error instanceof Error ? error.message : String(error)}`);
        if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(String(error?.message))) break;
      }
      await pause(pollSeconds * 1000, () => stopped);
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
    notify: relay.notify,
    handle,
    poll
  };
}
