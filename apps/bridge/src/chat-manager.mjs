// Setting up chat apps from Settings in Chrome: the paired extension asks the
// helper app to check a bot's details, save them, allow people and turn apps
// off, the same things the `<app> setup|allow|off` commands do, with the bots
// changed in place. Tokens and passwords are never sent back.
import { CHAT_APP_NAMES, forgetStranger, waitingStrangers } from "./chat-relay.mjs";

// What Settings may send for a setup. The path to signal-cli is left out on
// purpose: only the command on this computer can choose a program to run.
const SETUP_FIELDS = ["token", "bot_token", "app_token", "server", "homeserver", "address", "password", "imap", "smtp", "number"];

const coded = (code, message) => Object.assign(new Error(message), { code });

/**
 * @param {{
 *   specs: Record<string, { idPattern: RegExp, idHint: string, setup: (current: object, input: object) => Promise<{ settings: object, report: object }> }>,
 *   load: () => Promise<object>,
 *   save: (config: object) => Promise<void>,
 *   createApp: (app: string, config: object) => ({ app: string, start(): void, stop(): void, allow(ids: string[]): void } | null),
 *   isSetUp: (current: object) => boolean,
 *   inviteUrl?: (app: string, current: object) => string | undefined
 * }} options
 */
export function createChatManager({ specs, load, save, createApp, isSetUp, inviteUrl = () => undefined }) {
  const running = new Map();

  function restart(app, config) {
    running.get(app)?.stop();
    running.delete(app);
    const relay = createApp(app, config);
    if (relay) {
      relay.start();
      running.set(app, relay);
    }
  }

  function appStatus(app, config) {
    const current = config[app] || {};
    const allowed = (current.allowed_user_ids || []).map(String);
    const names = current.allowed_names || {};
    return {
      app,
      set_up: isSetUp(current),
      running: running.has(app),
      bot: current.bot ? (app === "telegram" || app === "mattermost" ? `@${current.bot}` : current.bot) : undefined,
      team: current.team,
      number: current.number,
      address: current.address,
      server: current.server,
      homeserver: current.homeserver,
      invite: current.bot_id ? inviteUrl(app, current) : undefined,
      allowed: allowed.map((id) => ({ id, name: typeof names[id] === "string" ? names[id] : "" })),
      waiting: waitingStrangers(app).filter((entry) => !allowed.includes(entry.id))
    };
  }

  async function handle(action, args = {}) {
    if (action === "status") {
      const config = await load();
      return {
        apps: Object.fromEntries(Object.keys(specs).map((app) => [app, appStatus(app, config)])),
        voice_notes: Boolean(config.voice?.model)
      };
    }
    const app = String(args.app || "");
    const spec = Object.hasOwn(specs, app) ? specs[app] : null;
    if (!spec) throw coded("UNKNOWN_CHAT_APP", `There is no chat app called “${app}”.`);
    const config = await load();
    const current = config[app] || {};
    const name = CHAT_APP_NAMES[app];

    if (action === "setup") {
      const input = {};
      for (const field of SETUP_FIELDS) {
        if (typeof args[field] === "string" && args[field].trim()) input[field] = args[field].trim();
      }
      const { settings, report } = await spec.setup(current, input);
      const next = { ...config, [app]: { ...current, ...settings, allowed_user_ids: current.allowed_user_ids || [] } };
      await save(next);
      restart(app, next);
      return { ...appStatus(app, next), next: report.next };
    }

    if (action === "allow" || action === "remove") {
      if (!isSetUp(current)) throw coded("CHAT_APP_NOT_SET_UP", `Set up ${name} first.`);
      let id = String(args.id ?? "").trim();
      if (app === "email") id = id.toLowerCase();
      const before = (current.allowed_user_ids || []).map(String);
      // A name to show next to the account, like the one the bot was sent.
      const names = Object.fromEntries(Object.entries(current.allowed_names || {}).filter(([key]) => key !== id));
      let ids;
      if (action === "allow") {
        if (!spec.idPattern.test(id)) throw coded("BAD_ACCOUNT_ID", `That doesn't look like ${spec.idHint}.`);
        ids = [...new Set([...before, id])];
        const name = String(args.name ?? "").trim().slice(0, 80);
        if (name) names[id] = name;
        forgetStranger(app, id);
      } else {
        ids = before.filter((value) => value !== id);
      }
      const next = { ...config, [app]: { ...current, allowed_user_ids: ids, allowed_names: names } };
      await save(next);
      running.get(app)?.allow(ids);
      return appStatus(app, next);
    }

    if (action === "off") {
      const { [app]: _removed, ...next } = config;
      await save(next);
      restart(app, next);
      forgetStranger(app);
      return appStatus(app, next);
    }

    throw coded("UNKNOWN_ACTION", `Unknown chat app action “${action}”.`);
  }

  return {
    handle,
    /** Starts a bot for each chat app that is set up. */
    start(config) {
      for (const app of Object.keys(specs)) restart(app, config);
    },
    stopAll() {
      for (const relay of running.values()) relay.stop();
      running.clear();
    },
    relays: () => [...running.values()]
  };
}
