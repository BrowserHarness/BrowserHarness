#!/usr/bin/env node
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  open,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBridgeServer,
  isLoopbackHost,
  REMOTE_MIN_TOKEN_LENGTH
} from "./core.mjs";
import { serveBrowserHarnessMcp } from "./mcp.mjs";
import { createTelegramRelay, telegramApi } from "./telegram.mjs";
import { createDiscordRelay, discordApi, discordInviteUrl } from "./discord.mjs";
import { createSlackRelay, slackApi } from "./slack.mjs";
import { createSignalRelay, runSignalCli, SIGNAL_ID } from "./signal.mjs";
import { createMattermostRelay, mattermostApi } from "./mattermost.mjs";
import { createMatrixRelay, matrixApi } from "./matrix.mjs";
import { createEmailRelay, hostPort, openImap, providerFor, sendSmtp } from "./email.mjs";
import { CHAT_APP_NAMES } from "./chat-relay.mjs";
import { createTranscriber, silentWav, voiceServiceUrl } from "./voice.mjs";
import {
  detectAgents,
  findOnPath,
  installContext,
  installLauncher,
  uninstallLauncher,
  installService,
  registerAgents,
  stableCliPath,
  uninstallService,
  unregisterAgents
} from "./install.mjs";
import { createLlmAdapterManager } from "./llm-adapters.mjs";
import {
  createMcpClientManager,
  DEFAULT_MCP_SERVERS_FILE
} from "./mcp-client.mjs";

const THIS_FILE = fileURLToPath(import.meta.url);
// Set by the single-file build (scripts/build-bridge.mjs).
const BUNDLED = typeof __BROWSERHARNESS_BUNDLED__ !== "undefined";
const USER_HOME = os.homedir();
const HOME = path.join(USER_HOME, ".browserharness-bridge");
const CONFIG_FILE = path.join(HOME, "config.json");
const PID_FILE = path.join(HOME, "daemon.pid");
const ADDR_FILE = path.join(HOME, "daemon.addr");
const LOG_DIR = path.join(HOME, "logs");
const LOG_FILE = path.join(LOG_DIR, "daemon.log");

function print(value) {
  process.stdout.write(
    typeof value === "string"
      ? `${value}\n`
      : `${JSON.stringify(value)}\n`
  );
}

async function ensureConfig() {
  await mkdir(HOME, { recursive: true });
  try {
    const config = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
    return { config, created: false };
  } catch {
    const config = {
      host: "127.0.0.1",
      port: 10087,
      allow_remote: false,
      token: crypto.randomBytes(24).toString("hex")
    };
    await writeFile(
      CONFIG_FILE,
      JSON.stringify(config, null, 2) + "\n",
      { mode: 0o600 }
    );
    return { config, created: true };
  }
}

// Address used to reach the daemon from this machine. A wildcard bind
// (0.0.0.0 / ::) is not dialable, so map it to loopback.
function localHost(config) {
  if (config.host === "0.0.0.0") return "127.0.0.1";
  if (config.host === "::") return "::1";
  return config.host;
}

function httpBase(config) {
  const host = localHost(config);
  return `http://${host.includes(":") ? `[${host}]` : host}:${config.port}`;
}

function wsBase(config) {
  const host = localHost(config);
  return `ws://${host.includes(":") ? `[${host}]` : host}:${config.port}/ws`;
}

async function readStatus(config, timeoutMs = 900) {
  try {
    const response = await fetch(`${httpBase(config)}/status`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await response.json();
    if (!response.ok || body?.running !== true) {
      throw new Error("Not BrowserHarness Bridge");
    }
    return body;
  } catch {
    return {
      running: false,
      addr: `${config.host}:${config.port}`
    };
  }
}

async function waitForState(config, expectedRunning, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await readStatus(config, 500);
    if (Boolean(status.running) === expectedRunning) return status;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return readStatus(config, 500);
}

async function serve(config) {
  await mkdir(LOG_DIR, { recursive: true });
  const mcpManager = createMcpClientManager();
  let chatApps = [];
  const bridge = createBridgeServer({
    host: config.host,
    port: config.port,
    token: config.token,
    allowRemote: config.allow_remote === true,
    llmManager: createLlmAdapterManager(),
    mcpManager,
    chatApps: () => chatApps.map((relay) => relay.app),
    onExtensionEvent: async (message) => {
      if (message.type === "chat_notify") {
        const relay = chatApps.find((candidate) => candidate.app === message.app);
        await relay?.notify(message.text).catch((error) => process.stderr.write(`${message.app}: ${error.message}\n`));
        return;
      }
      for (const relay of chatApps) await relay.deliver(message.id, message).catch(() => undefined);
    }
  });
  const address = await bridge.listen();

  chatApps = startChatApps(config, (text, meta) =>
    bridge
      .sendCommand({ session: meta.from, title: CHAT_APP_NAMES[meta.from], action: "remote_task", args: { text, from: meta.from } })
      .then((result) => (result.ok ? { ok: true, id: result.data.id, reply: result.data.reply } : result))
      .catch((error) => ({ ok: false, error: { message: error.message } }))
  );

  await writeFile(PID_FILE, `${process.pid}\n`);
  await writeFile(
    ADDR_FILE,
    `${config.host}:${address.port}\n`
  );

  print({
    running: true,
    pid: process.pid,
    addr: `${config.host}:${address.port}`,
    ws: wsBase(config)
  });

  const shutdown = async () => {
    for (const relay of chatApps) relay.stop();
    await bridge.close().catch(() => undefined);
    await Promise.all([
      rm(PID_FILE, { force: true }),
      rm(ADDR_FILE, { force: true })
    ]);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

async function start(config, created, cliPath = THIS_FILE, { quiet = false } = {}) {
  const current = await readStatus(config);
  if (current.running) {
    if (quiet) return;
    print({
      ...current,
      ws: wsBase(config),
      note: "BrowserHarness Bridge is already running"
    });
    return;
  }

  await mkdir(LOG_DIR, { recursive: true });
  const log = await open(LOG_FILE, "a");

  const child = spawn(
    process.execPath,
    [cliPath, "serve"],
    {
      detached: true,
      stdio: ["ignore", log.fd, log.fd]
    }
  );
  child.unref();
  await log.close();

  const status = await waitForState(config, true);
  if (!status.running) {
    throw new Error(
      `BrowserHarness Bridge did not start. Check ${LOG_FILE}`
    );
  }

  if (quiet) return;
  print({
    ...status,
    ws: wsBase(config),
    config: CONFIG_FILE,
    ...(created
      ? {
          pairing_token: config.token,
          note:
            "Next: press Pair in BrowserHarness (Settings → Coding agents), then run: browserharness-bridge pair"
        }
      : {})
  });
}

async function stop(config, { quiet = false } = {}) {
  const current = await readStatus(config);
  if (!current.running) {
    await Promise.all([
      rm(PID_FILE, { force: true }),
      rm(ADDR_FILE, { force: true })
    ]);
    print({
      running: false,
      addr: `${config.host}:${config.port}`
    });
    return;
  }

  let pid;
  try {
    pid = Number((await readFile(PID_FILE, "utf8")).trim());
  } catch {
    throw new Error(
      `Bridge is running but ${PID_FILE} is missing; stop that process manually.`
    );
  }

  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("Invalid BrowserHarness Bridge PID file");
  }

  process.kill(pid, "SIGTERM");
  const status = await waitForState(config, false);

  if (status.running) {
    throw new Error(
      "BrowserHarness Bridge did not stop within the expected window"
    );
  }

  await Promise.all([
    rm(PID_FILE, { force: true }),
    rm(ADDR_FILE, { force: true })
  ]);
  if (!quiet) print(status);
}

async function listMcpServers() {
  const manager = createMcpClientManager();
  try {
    print({
      config: DEFAULT_MCP_SERVERS_FILE,
      servers: await manager.listServers()
    });
  } finally {
    await manager.closeAll();
  }
}

async function setRemote(config, args) {
  const mode = args[0];
  if (mode === "on") {
    const host = args[1] || "0.0.0.0";
    if (isLoopbackHost(host)) {
      throw new Error("remote on needs a non-loopback bind host, e.g. 0.0.0.0");
    }
    const next = {
      ...config,
      host,
      allow_remote: true,
      token:
        config.token.length >= REMOTE_MIN_TOKEN_LENGTH
          ? config.token
          : crypto.randomBytes(24).toString("hex")
    };
    await writeFile(CONFIG_FILE, JSON.stringify(next, null, 2) + "\n", {
      mode: 0o600
    });
    print({
      remote: true,
      host,
      port: next.port,
      token_rotated: next.token !== config.token,
      note:
        "Restart the Bridge to apply. The Bridge speaks plain ws:// on its port: put it behind a TLS reverse proxy and give the extension the wss:// address. Anyone holding the pairing token can drive the paired browser."
    });
  } else if (mode === "off") {
    const next = { ...config, host: "127.0.0.1", allow_remote: false };
    await writeFile(CONFIG_FILE, JSON.stringify(next, null, 2) + "\n", {
      mode: 0o600
    });
    print({ remote: false, host: "127.0.0.1", note: "Restart the Bridge to apply." });
  } else {
    print({
      remote: config.allow_remote === true && !isLoopbackHost(config.host),
      host: config.host,
      port: config.port
    });
  }
}

async function logs() {
  const nIndex = process.argv.indexOf("-n");
  const requested =
    nIndex >= 0 ? Number(process.argv[nIndex + 1]) : 80;
  const count =
    Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), 5000)
      : 80;

  try {
    const text = await readFile(LOG_FILE, "utf8");
    print(text.split(/\r?\n/).slice(-count).join("\n"));
  } catch {
    print(`No bridge log exists yet at ${LOG_FILE}`);
  }
}


function flag(name) {
  return process.argv.includes(`--${name}`);
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function bridgeRequest(config, pathname, body, timeoutMs = 5000) {
  const response = await fetch(`${httpBase(config)}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.token}`
    },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeoutMs)
  });
  return response.json();
}

/** `skills` lists the person's Skills; `skill <name> [details]` prints one, ready to follow. */
async function skillsCommand(config, name, details) {
  const result = await bridgeRequest(config, "/command", {
    session: "cli",
    title: "Skills",
    action: "skills",
    args: name ? { name, details } : {}
  }).catch(() => ({
    ok: false,
    error: { message: "The bridge is not running. Start it with: browserharness-bridge start" }
  }));
  if (!result?.ok) throw new Error(result?.error?.message || "Couldn't read Skills from Chrome");
  if (name) {
    process.stdout.write(`${result.data.instructions}\n`);
  } else if (flag("json")) {
    print(result.data);
  } else if (!result.data.skills.length) {
    process.stdout.write("No Skills yet. Save one from the BrowserHarness side panel (Save as Skill).\n");
  } else {
    for (const skill of result.data.skills) {
      process.stdout.write(`${skill.name.padEnd(28)} ${skill.title}\n`);
    }
  }
}

/**
 * `sites` lists the commands BrowserHarness learned from websites;
 * `site <name> [kettle | --q kettle | q=kettle]` runs one in Chrome.
 */
async function sitesCommand(config, name, args = []) {
  const session = name ? `cli-site-${process.pid}` : "cli";
  const result = await bridgeRequest(
    config,
    "/command",
    {
      session,
      title: name ? `Site command ${name}` : "Site commands",
      action: "site_commands",
      args: name ? { name, args: args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ") } : {}
    },
    60_000
  ).catch(() => ({
    ok: false,
    error: { message: "The bridge is not running. Start it with: browserharness-bridge start" }
  }));
  if (!result?.ok) throw new Error(result?.error?.message || "Couldn't reach Chrome");
  if (name && result.data.kind === "read") {
    // The answer is printed here; close the tab it opened.
    await bridgeRequest(config, "/command", { session, action: "close_session", args: {} }).catch(() => undefined);
  }
  if (flag("json") || (name && result.data.kind === "read" && typeof result.data.output === "object")) {
    process.stdout.write(`${JSON.stringify(name ? result.data.output ?? result.data : result.data, null, 2)}\n`);
  } else if (name) {
    process.stdout.write(
      result.data.kind === "read"
        ? `${result.data.output ?? ""}\n`
        : `${result.data.submitted ? "Filled and sent the form" : "Filled the form without sending it"} on ${result.data.site}.\n`
    );
  } else if (!result.data.commands.length) {
    process.stdout.write(`${result.data.hint}\n`);
  } else {
    for (const command of result.data.commands) {
      process.stdout.write(`${command.usage.padEnd(48)} ${command.kind === "read" ? "gets data " : "fills form"}  ${command.site}\n`);
    }
  }
}

async function saveConfig(next) {
  await writeFile(CONFIG_FILE, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
}

async function restartIfRunning(config) {
  if ((await readStatus(config)).running) {
    await stop(config, { quiet: true }).catch(() => undefined);
    await start(config, false, THIS_FILE, { quiet: true });
    return true;
  }
  return false;
}

/** Starts a bot for each chat app that is set up. */
function startChatApps(config, runTask) {
  const log = (line) => process.stderr.write(`${line}\n`);
  const relays = [];
  let transcribe = null;
  if (config.voice?.model) {
    try {
      transcribe = createTranscriber({ url: config.voice.url, model: config.voice.model, apiKey: config.voice.key || "", language: config.voice.language || "" });
    } catch (error) {
      log(`voice notes: ${error.message}`);
    }
  }
  const { telegram, discord, slack, signal } = config;
  if (telegram?.token) {
    relays.push(createTelegramRelay({ token: telegram.token, allowedUserIds: telegram.allowed_user_ids || [], apiBase: telegram.api_base, runTask, transcribe, log }));
  }
  if (discord?.token) {
    relays.push(
      createDiscordRelay({
        token: discord.token,
        botId: discord.bot_id,
        allowedUserIds: discord.allowed_user_ids || [],
        apiBase: discord.api_base,
        gatewayUrl: discord.gateway_url,
        runTask,
        transcribe,
        log
      })
    );
  }
  if (slack?.bot_token && slack?.app_token) {
    relays.push(
      createSlackRelay({
        botToken: slack.bot_token,
        appToken: slack.app_token,
        allowedUserIds: slack.allowed_user_ids || [],
        apiBase: slack.api_base,
        runTask,
        transcribe,
        log
      })
    );
  }
  if (signal?.number) {
    relays.push(createSignalRelay({
        number: signal.number,
        command: signal.command,
        dataDir: signal.data_dir,
        allowedUserIds: signal.allowed_user_ids || [],
        runTask,
        transcribe,
        log
      }));
  }
  const { mattermost, matrix, email } = config;
  if (mattermost?.token) {
    relays.push(
      createMattermostRelay({
        server: mattermost.server,
        token: mattermost.token,
        botId: mattermost.bot_id,
        botName: mattermost.bot,
        allowedUserIds: mattermost.allowed_user_ids || [],
        runTask,
        transcribe,
        log
      })
    );
  }
  if (matrix?.token) {
    relays.push(
      createMatrixRelay({
        homeserver: matrix.homeserver,
        token: matrix.token,
        botId: matrix.bot,
        allowedUserIds: matrix.allowed_user_ids || [],
        runTask,
        transcribe,
        log
      })
    );
  }
  if (email?.password) {
    relays.push(
      createEmailRelay({
        ...emailSettings(email),
        allowedUserIds: email.allowed_user_ids || [],
        pollSeconds: Math.max(5, Number(email.poll_seconds) || 30),
        runTask,
        log
      })
    );
  }
  for (const relay of relays) relay.start();
  return relays;
}

/** Where an email bot reads and sends mail; plain connections only to this computer. */
function emailSettings(email) {
  const secure = email.secure !== false;
  return {
    address: email.address,
    password: email.password,
    imap: { ...hostPort(email.imap, 993), secure },
    smtp: { ...hostPort(email.smtp, 465), secure }
  };
}

const isChatAppSetUp = (current) => Boolean(current.token || current.bot_token || current.number || current.password);

/** What each chat app needs: how to check it, what an account id looks like. */
const CHAT_APPS = {
  telegram: {
    usage: "telegram setup --token <token from @BotFather>",
    idPattern: /^\d+$/,
    idHint: "your Telegram user id",
    async setup(current) {
      const token = option("token") || process.argv[4];
      if (!token || token.startsWith("--")) throw new Error(`Usage: browserharness-bridge ${this.usage}`);
      const me = await telegramApi(token, current.api_base).getMe();
      return {
        settings: { token, bot: me.username },
        report: { bot: `@${me.username}`, next: `Send any message to @${me.username}. It will reply with the command that allows your Telegram account.` }
      };
    }
  },
  discord: {
    usage: "discord setup --token <bot token from the Discord Developer Portal>",
    idPattern: /^\d+$/,
    idHint: "your Discord user id",
    async setup(current) {
      const token = option("token") || process.argv[4];
      if (!token || token.startsWith("--")) throw new Error(`Usage: browserharness-bridge ${this.usage}`);
      const me = await discordApi(token, current.api_base).getMe();
      return {
        settings: { token, bot: me.username, bot_id: me.id },
        report: {
          bot: me.username,
          invite: discordInviteUrl(me.id),
          next: `Open the invite link to add ${me.username} to a server you own, then send it a direct message. It will reply with the command that allows your Discord account.`
        }
      };
    }
  },
  slack: {
    usage: "slack setup --bot-token <xoxb-…> --app-token <xapp-…>",
    idPattern: /^[UW][A-Z0-9]+$/,
    idHint: "your Slack member id",
    async setup(current) {
      const botToken = option("bot-token");
      const appToken = option("app-token");
      if (!botToken || !appToken) throw new Error(`Usage: browserharness-bridge ${this.usage}`);
      const api = slackApi({ botToken, appToken, apiBase: current.api_base });
      const me = await api.authTest();
      await api.openConnection();
      return {
        settings: { bot_token: botToken, app_token: appToken, bot: me.user, team: me.team },
        report: { bot: me.user, team: me.team, next: `Send ${me.user} a direct message in Slack. It will reply with the command that allows your Slack account.` }
      };
    }
  },
  mattermost: {
    usage: "mattermost setup --server <https://your.mattermost.server> --token <bot access token>",
    idPattern: /^[a-z0-9]{26}$/,
    idHint: "your Mattermost user id (the bot tells you)",
    async setup(current) {
      const server = option("server") || current.server;
      const token = option("token");
      if (!server || !token) throw new Error(`Usage: browserharness-bridge ${this.usage}`);
      const me = await mattermostApi({ server, token }).getMe();
      return {
        settings: { server, token, bot: me.username, bot_id: me.id },
        report: { bot: `@${me.username}`, next: `Send @${me.username} a direct message in Mattermost. It will reply with the command that allows your account.` }
      };
    }
  },
  matrix: {
    usage: "matrix setup --homeserver <https://matrix.example.org> --token <the bot account's access token>",
    idPattern: /^@[^:\s]+:\S+$/,
    idHint: "your Matrix id, like @you:matrix.org",
    async setup(current) {
      const homeserver = option("homeserver") || current.homeserver;
      const token = option("token");
      if (!homeserver || !token) throw new Error(`Usage: browserharness-bridge ${this.usage}`);
      const me = await matrixApi({ homeserver, token }).whoami();
      return {
        settings: { homeserver, token, bot: me.user_id },
        report: {
          bot: me.user_id,
          next: `Allow your Matrix id first (browserharness-bridge matrix allow @you:server), then invite ${me.user_id} to a room with encryption turned off.`
        }
      };
    }
  },
  email: {
    usage: "email setup --address <the bot's mailbox> --password <app password> [--imap host:993] [--smtp host:465]",
    idPattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
    idHint: "your email address",
    async setup(current) {
      const address = option("address") || current.address;
      const password = option("password");
      const known = providerFor(address);
      const imap = option("imap") || current.imap || known?.imap;
      const smtp = option("smtp") || current.smtp || known?.smtp;
      if (!address || !password) throw new Error(`Usage: browserharness-bridge ${this.usage}`);
      if (!imap || !smtp) throw new Error(`I don't know the mail servers for ${address}. Add --imap host:993 --smtp host:465 from your provider's help page.`);
      const settings = { address, password, imap, smtp, ...(current.secure === false ? { secure: false } : {}) };
      const check = emailSettings(settings);
      const box = await openImap({ ...check.imap, user: address, password });
      await box.close();
      await sendSmtp({ ...check.smtp, user: address, password, checkOnly: true });
      return {
        settings,
        report: { address, imap, smtp, next: `Allow your own address (browserharness-bridge email allow you@example.com), then email ${address} a task.` }
      };
    }
  },
  signal: {
    usage: "signal setup --number <the bot's number, like +15551234567> [--command <path to signal-cli>]",
    idPattern: SIGNAL_ID,
    idHint: "your phone number with country code, like +15551234567",
    async setup(current) {
      const number = option("number") || process.argv[4];
      const command = option("command") || current.command || "signal-cli";
      if (!number || !SIGNAL_ID.test(number) || !number.startsWith("+")) throw new Error(`Usage: browserharness-bridge ${this.usage}`);
      const version = await runSignalCli(command, ["--version"]);
      return {
        settings: { number, command },
        report: { number, signal_cli: version, next: `Send a Signal message to ${number}. It will reply with the command that allows your number.` }
      };
    }
  }
};

/** `<app> setup …`, `<app> allow <id>`, `<app> off`, `<app> status` for each chat app. */
async function chatCommand(app, config, args) {
  const [mode, given] = args;
  const value = app === "email" ? given?.toLowerCase() : given;
  const spec = CHAT_APPS[app];
  const current = config[app] || {};
  const name = CHAT_APP_NAMES[app];
  const isSetUp = isChatAppSetUp(current);
  if (mode === "setup") {
    const { settings, report } = await spec.setup(current);
    const next = { ...config, [app]: { ...current, ...settings, allowed_user_ids: current.allowed_user_ids || [] } };
    await saveConfig(next);
    print({ [app]: true, ...report, restarted: await restartIfRunning(next) });
  } else if (mode === "allow") {
    if (!isSetUp) throw new Error(`Set up ${name} first: browserharness-bridge ${spec.usage}`);
    if (!spec.idPattern.test(value || "")) throw new Error(`Usage: browserharness-bridge ${app} allow <${spec.idHint}>`);
    const ids = [...new Set([...(current.allowed_user_ids || []).map(String), value])];
    const next = { ...config, [app]: { ...current, allowed_user_ids: ids } };
    await saveConfig(next);
    const restarted = await restartIfRunning(next);
    print({ [app]: true, allowed_user_ids: ids, restarted, note: restarted ? "Message the bot to try it." : "Start the Bridge to use it: browserharness-bridge start" });
  } else if (mode === "off") {
    const { [app]: _removed, ...next } = config;
    await saveConfig(next);
    print({ [app]: false, restarted: await restartIfRunning(next) });
  } else {
    // Never prints tokens.
    print({
      [app]: isSetUp,
      bot: current.bot ? (app === "telegram" ? `@${current.bot}` : current.bot) : undefined,
      number: current.number,
      address: current.address,
      allowed_user_ids: current.allowed_user_ids || []
    });
  }
}

const VOICE_USAGE = "voice setup --url <speech-to-text service, like https://api.example.com/v1> --model <its model> [--key <API key>] [--language en]";

/** `voice setup …`, `voice off`, `voice status`: turning voice notes into tasks. */
async function voiceCommand(config, mode) {
  const current = config.voice || {};
  if (mode === "setup") {
    const given = option("url");
    const model = option("model") || (given ? "" : current.model);
    if (!(given || current.url) || !model) throw new Error(`Usage: browserharness-bridge ${VOICE_USAGE}`);
    const url = voiceServiceUrl(given || current.url);
    // A saved key is kept only for the same service.
    const key = option("key") ?? (url === current.url ? current.key || "" : "");
    const language = option("language") ?? current.language ?? "";
    // One second of silence checks the address, model and key without recording anything.
    await createTranscriber({ url, model, apiKey: key, language })(silentWav());
    const next = { ...config, voice: { url, model, ...(key ? { key } : {}), ...(language ? { language } : {}) } };
    await saveConfig(next);
    print({
      voice: true,
      url,
      model,
      chat_apps: Object.keys(CHAT_APPS).filter((app) => app !== "email" && isChatAppSetUp(config[app] || {})),
      next: "Send your bot a voice note. Its words run as the task, and the bot says what it heard.",
      restarted: await restartIfRunning(next)
    });
  } else if (mode === "off") {
    const { voice: _removed, ...next } = config;
    await saveConfig(next);
    print({ voice: false, restarted: await restartIfRunning(next) });
  } else {
    // Never prints the key.
    print({ voice: Boolean(current.model), url: current.url, model: current.model, language: current.language, setup: current.model ? undefined : `browserharness-bridge ${VOICE_USAGE}` });
  }
}

/** Every chat app at a glance. */
function chatsCommand(config) {
  print({
    chats: Object.keys(CHAT_APPS).map((app) => {
      const current = config[app] || {};
      return {
        app,
        on: isChatAppSetUp(current),
        bot: current.bot || current.number || current.address,
        allowed: (current.allowed_user_ids || []).length
      };
    }),
    voice_notes: config.voice?.model ? `on (${config.voice.model})` : `off: browserharness-bridge ${VOICE_USAGE}`,
    setup: Object.values(CHAT_APPS).map((spec) => `browserharness-bridge ${spec.usage}`)
  });
}

async function waitForExtension(config, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await readStatus(config, 800);
    if (status.extension_connected) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function askLine(question) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

const PAIR_HELP =
  "In Chrome, open BrowserHarness → Settings → Coding agents and press Pair. It shows a 6-digit code.";

// How to run this program again from a terminal.
function commandHint(cliPath = THIS_FILE) {
  return findOnPath("browserharness-bridge")
    ? "browserharness-bridge"
    : `node "${cliPath}"`;
}

/**
 * Approve the extension's pairing request by its code. With --code it runs
 * without questions; in a terminal it asks for the code.
 */
async function pair(config, { code, interactive, json }) {
  const status = await readStatus(config);
  if (!status.running) {
    throw new Error(`The Bridge is not running. Run: ${commandHint()} install`);
  }
  let attempts = interactive ? 3 : 1;
  let entered = code;
  if (!entered && interactive) print(PAIR_HELP);
  while (attempts > 0) {
    attempts -= 1;
    if (!entered && interactive) {
      entered = await askLine("Type the code here (or press Enter to skip): ");
      if (!entered) {
        print(`Skipped. Pair later with: ${commandHint()} pair`);
        return { paired: false };
      }
    }
    if (!entered) {
      throw new Error(`${PAIR_HELP} Then run: ${commandHint()} pair --code <code>`);
    }
    const result = await bridgeRequest(config, "/pair/approve", { code: entered });
    if (result.ok) {
      const connected = await waitForExtension(config, 15_000);
      const outcome = { paired: true, extension_connected: connected };
      if (json) print(outcome);
      else
        print(
          connected
            ? "Paired. BrowserHarness in Chrome is connected."
            : "Approved. BrowserHarness will connect in a few seconds."
        );
      return outcome;
    }
    print(result.error?.message || "That code did not match.");
    entered = undefined;
  }
  throw new Error(`Pairing was not completed. Run ${commandHint()} pair to try again.`);
}

function context(cliPath) {
  return installContext({ home: USER_HOME, cliPath });
}

async function install(config, created) {
  const json = flag("json");
  const say = (line) => {
    if (!json) print(line);
  };
  const cliPath = await stableCliPath({ cliPath: THIS_FILE, home: USER_HOME, bundled: BUNDLED });
  const ctx = context(cliPath);

  say("Installing BrowserHarness Bridge…");
  await mkdir(LOG_DIR, { recursive: true });
  const launcher = await installLauncher(ctx);
  if ((await readStatus(config)).running) {
    await stop(config, { quiet: true });
  }

  let service = { kind: "none", running: false };
  if (!flag("no-service")) {
    service = await installService(ctx);
  }
  if (!service.running) {
    await start(config, false, cliPath, { quiet: true });
  }
  const status = await waitForState(config, true, 8000);
  if (!status.running) {
    throw new Error(`BrowserHarness Bridge did not start. Check ${LOG_FILE}`);
  }
  say(
    service.kind !== "none" && (service.running || service.kind === "startup-folder")
      ? "✓ Bridge is running and starts when you log in."
      : `✓ Bridge is running.${service.note ? ` ${service.note}` : ""}`
  );

  let agents = [];
  if (!flag("no-agents")) {
    const only = option("agents")?.split(",").map((value) => value.trim()).filter(Boolean);
    agents = await registerAgents(ctx, { only });
    for (const agent of agents) {
      if (agent.status === "connected") say(`✓ ${agent.name}: connected (ask it to use BrowserHarness, or type /browserharness)`);
      else if (agent.status === "failed") say(`✗ ${agent.name}: ${agent.error}`);
    }
    if (!agents.some((agent) => agent.status === "connected")) {
      say("No coding agents found (Claude Code, Codex, Cursor, Hermes). Install one, then run this again.");
    }
  }

  const summary = {
    installed: true,
    cli: cliPath,
    launcher,
    service: { kind: service.kind, file: service.file, starts_at_login: service.kind !== "none" && (service.running || service.kind === "startup-folder") },
    agents,
    extension_connected: Boolean(status.extension_connected)
  };
  if (json) print(summary);

  if (status.extension_connected) {
    say("✓ BrowserHarness in Chrome is already connected. You're ready.");
  } else if (!flag("no-pair") && process.stdin.isTTY) {
    await pair(config, { interactive: true });
  } else if (!json) {
    say(`Last step: ${PAIR_HELP} Then run: ${launcher ? "browserharness-bridge" : `node "${cliPath}"`} pair`);
  }
  return summary;
}

async function uninstall(config) {
  const cliPath = BUNDLED
    ? path.join(HOME, "bin", "browserharness-bridge.mjs")
    : THIS_FILE;
  const ctx = context(cliPath);
  const agents = await unregisterAgents(ctx);
  await uninstallLauncher(ctx);
  const service = await uninstallService(ctx);
  if ((await readStatus(config)).running) {
    await stop(config, { quiet: true }).catch(() => undefined);
  }
  await rm(path.join(HOME, "bin"), { recursive: true, force: true });
  if (flag("purge")) await rm(HOME, { recursive: true, force: true });
  print({ uninstalled: true, service: service.file, agents, purged: flag("purge") });
}

const command = process.argv[2] || "start";
const { config, created } = await ensureConfig();

try {
  if (command === "serve") {
    await serve(config);
  } else if (command === "mcp") {
    await serveBrowserHarnessMcp({ ...config, host: localHost(config) });
  } else if (command === "start") {
    await start(config, created);
  } else if (command === "status") {
    print(await readStatus(config));
  } else if (command === "stop") {
    await stop(config);
  } else if (command === "restart") {
    await stop(config);
    await start(config, false);
  } else if (command === "logs") {
    await logs();
  } else if (command === "mcp-servers") {
    await listMcpServers();
  } else if (command === "remote") {
    await setRemote(config, process.argv.slice(3));
  } else if (command === "install") {
    await install(config, created);
  } else if (command === "uninstall") {
    await uninstall(config);
  } else if (command === "agents") {
    print({ agents: detectAgents(context(THIS_FILE)) });
  } else if (command in CHAT_APPS) {
    const valueFlags = new Set(["--token", "--bot-token", "--app-token", "--number", "--command", "--server", "--homeserver", "--address", "--password", "--imap", "--smtp"]);
    await chatCommand(command, config, process.argv.slice(3).filter((arg, index, all) => !arg.startsWith("--") && !valueFlags.has(all[index - 1])));
  } else if (command === "voice") {
    await voiceCommand(config, process.argv[3]);
  } else if (command === "chats") {
    chatsCommand(config);
  } else if (command === "skills") {
    await skillsCommand(config);
  } else if (command === "skill") {
    const name = process.argv[3];
    if (!name) throw new Error("Usage: browserharness-bridge skill <name> [details]");
    await skillsCommand(config, name, process.argv.slice(4).join(" "));
  } else if (command === "sites") {
    await sitesCommand(config);
  } else if (command === "site") {
    const name = process.argv[3];
    if (!name) throw new Error("Usage: browserharness-bridge site <name> [value | --param value | param=value]");
    await sitesCommand(config, name, process.argv.slice(4).filter((arg) => arg !== "--json"));
  } else if (command === "pair") {
    if (flag("show-token")) {
      print({
        ws: wsBase(config),
        pairing_token: config.token,
        config: CONFIG_FILE
      });
    } else {
      await pair(config, {
        code: option("code"),
        interactive: process.stdin.isTTY && !option("code"),
        json: flag("json")
      });
    }
  } else {
    throw new Error(
      "Usage: browserharness-bridge [install|uninstall|pair|agents|skills|skill <name>|sites|site <name>|chats|voice|telegram|discord|slack|signal|mattermost|matrix|email|start|status|stop|restart|logs|remote|mcp|mcp-servers]"
    );
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}
