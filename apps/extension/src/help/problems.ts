// When something can't connect, say why in plain words, how to fix it, and
// which help guide explains more. Each guide has a page in the knowledge base
// (knowledge/help/<guide>.md) that will become a page on the website.

export const GUIDE_SLUGS = [
  "connect-your-ai",
  "set-up-helper-app",
  "ai-key-rejected",
  "ai-busy-or-limit",
  "ai-too-slow",
  "ai-cant-reach",
  "local-ai-not-running",
  "ollama-blocked",
  "ai-model-not-found",
  "ai-page-too-big",
  "ai-cant-use-browser",
  "ai-no-models",
  "allow-address",
  "openrouter-sign-in",
  "subscription-app-missing",
  "helper-not-running",
  "helper-not-connected",
  "helper-pairing-failed",
  "set-up-chat-apps",
  "chat-app-token-rejected",
  "chat-app-cant-reach",
  "something-went-wrong"
] as const;

export type GuideSlug = (typeof GUIDE_SLUGS)[number];

export interface Problem {
  /** What went wrong, as a short heading. */
  title: string;
  /** Why it happened, in one or two sentences. */
  reason: string;
  /** What to do, step by step. */
  fixes: string[];
  /** The help guide with more detail. */
  guide: GuideSlug;
  /** The original message, for someone helping. */
  detail?: string;
}

export interface AiContext {
  /** Runs on this computer (LM Studio, Ollama). */
  local?: boolean;
  /** Which app, for local AIs. */
  app?: "LM Studio" | "Ollama";
  /** The service's name, like "OpenRouter". */
  service?: string;
  model?: string;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error ?? "");
}

const statusIn = (message: string): number | undefined => {
  const match = message.match(/\((\d{3})\)|\bHTTP (\d{3})\b|\b(4\d\d|5\d\d)\b/);
  const value = match?.[1] || match?.[2] || match?.[3];
  return value ? Number(value) : undefined;
};

/** Turn an error from connecting to or testing an AI into a Problem. */
// "the AI service" must not become "the the AI service" or "your the AI service".
const the = (service: string) => (/^(the|your) /.test(service) ? service : `the ${service}`);
const your = (service: string) => (/^(the|your) /.test(service) ? service.replace(/^the /, "your ") : `your ${service}`);

export function diagnoseAi(error: unknown, context: AiContext = {}): Problem {
  const problem = diagnose(error, context);
  return { ...problem, title: problem.title.charAt(0).toUpperCase() + problem.title.slice(1) };
}

function diagnose(error: unknown, context: AiContext): Problem {
  const detail = messageOf(error).trim();
  const status = statusIn(detail);
  const service = context.service || (context.local ? context.app || "your AI app" : "the AI service");
  const app = context.app || "LM Studio or Ollama";

  if (/did not allow|did not grant|permission/i.test(detail)) {
    return {
      title: "Chrome didn't allow BrowserHarness to reach this address",
      reason: "Chrome asks before an extension may talk to a new address, and the answer was no, or the question was closed.",
      fixes: ["Press the button again.", "When Chrome asks, choose Allow."],
      guide: "allow-address",
      detail
    };
  }
  if (/sign-in was cancelled|sign-in was not completed|did not return a sign-in code|could not open the openrouter sign-in|openrouter could not finish|did not return a key/i.test(detail)) {
    return {
      title: "The OpenRouter sign-in didn't finish",
      reason: "The OpenRouter window was closed, or you didn't press Authorize, so no connection was made.",
      fixes: [
        "Press Connect again.",
        "Sign in to OpenRouter (or make a free account) in the window that opens.",
        "Press Authorize, and wait for the window to close by itself."
      ],
      guide: "openrouter-sign-in",
      detail
    };
  }
  if (/context window|context length|too many tokens|n_ctx/i.test(detail)) {
    return {
      title: "The page is too big for this AI",
      reason: `${context.model || "This model"} can only read a limited amount of text at once, and this page is longer.`,
      fixes: context.local
        ? [`In ${app}, load the model again with a bigger "context length" (16,000 or more).`, "Or choose a bigger model."]
        : ["Choose a model that can read more at once (most large models can)."],
      guide: "ai-page-too-big",
      detail
    };
  }
  if (status === 413 || /request too large/i.test(detail)) {
    return {
      title: `The page is too big for ${your(service)} plan`,
      reason: `On your plan, often a free one, ${service} only takes a limited amount of text per request, and this page needs more.`,
      fixes: [
        "Ask about a shorter page, or one part of this page.",
        `Or choose a model with a higher limit, or raise your limit on ${the(service)} website.`
      ],
      guide: "ai-page-too-big",
      detail
    };
  }
  if (status === 401 || status === 402 || /unauthori[sz]ed|invalid api key|incorrect api key|invalid_api_key|authentication|insufficient credits|payment required/i.test(detail)) {
    if (context.local) {
      return {
        title: `${app} asked for a key`,
        reason: `${app} is set to need a secret key, and BrowserHarness doesn't have the right one.`,
        fixes: [
          `In ${app}, look in its server settings for a key, or turn that requirement off.`,
          "If it shows a key, paste it under Settings → Your AI → More ways to connect.",
          "Press Test and save again."
        ],
        guide: "ai-key-rejected",
        detail
      };
    }
    return {
      title: `${service} said no to your key`,
      reason: "The secret key is wrong or was deleted, or your account needs credit before it can be used.",
      fixes: [
        `Open ${your(service)} account on its website and check it has credit.`,
        "Make a new secret key there and paste it here, with nothing extra before or after it.",
        "Press Test and save again."
      ],
      guide: "ai-key-rejected",
      detail
    };
  }
  if (status === 403 && context.app === "Ollama") {
    return {
      title: "Ollama blocked BrowserHarness",
      reason: "Ollama only answers programs it trusts, and it doesn't trust Chrome extensions yet.",
      fixes: [
        "Quit Ollama.",
        "Start it again with this setting: OLLAMA_ORIGINS=chrome-extension://* ollama serve",
        "Then try again."
      ],
      guide: "ollama-blocked",
      detail
    };
  }
  if (status === 403) {
    return {
      title: `${service} refused the request`,
      reason: "Your account isn't allowed to use this model, or the service blocked the request.",
      fixes: [`Check on ${the(service)} website that your account may use this model.`, "Or choose another model."],
      guide: "ai-key-rejected",
      detail
    };
  }
  if (status === 404 || /model[^.]*not (found|exist)|no such model|unknown model|does not exist/i.test(detail)) {
    return {
      title: `${service} doesn't know this model`,
      reason: `The model name ${context.model ? `“${context.model}” ` : ""}isn't available there. It may be spelled differently, or it was removed.`,
      fixes: ["Choose the model from the list instead of typing it.", "If you typed it, copy the exact name from the service's website."],
      guide: "ai-model-not-found",
      detail
    };
  }
  if (status === 429 || /rate.?limit|too many requests|quota|overloaded/i.test(detail) || status === 529) {
    return {
      title: `${service} is busy, or your limit is used up`,
      reason: "The service is getting too many requests right now, or your plan's limit for today is reached.",
      fixes: ["Wait a minute and try again.", `If it keeps happening, check your plan or credit on ${the(service)} website.`, "Or add a Backup AI under Your AI."],
      guide: "ai-busy-or-limit",
      detail
    };
  }
  if (/timed out|timeout|aborted/i.test(detail)) {
    return {
      title: "The AI took too long to answer",
      reason: context.local
        ? "AIs on your own computer can be slow, especially big ones or the first answer after loading."
        : "The service didn't answer in time. It may be busy or having a problem.",
      fixes: context.local
        ? [`Check ${app} is still running and the model is loaded.`, "Try again: the second answer is often faster.", "Or choose a smaller model."]
        : ["Try again in a minute.", "Or choose another model."],
      guide: "ai-too-slow",
      detail
    };
  }
  if (/failed to fetch|networkerror|network error|load failed|econnrefused|err_connection|could not reach|not reachable/i.test(detail)) {
    return context.local
      ? {
          title: `${app} isn't answering`,
          reason: `BrowserHarness looked for ${app} on this computer but nothing answered. The app is closed, or its server isn't started.`,
          fixes: [
            `Open ${app}.`,
            app === "Ollama"
              ? "Ollama usually starts by itself. If it doesn't, open a terminal and type ollama serve."
              : app === "LM Studio"
                ? "In LM Studio, open the Developer tab and press Start Server."
                : "In LM Studio, open the Developer tab and press Start Server. Ollama starts by itself.",
            "Make sure a model is downloaded and loaded.",
            "Then try again."
          ],
          guide: "local-ai-not-running",
          detail
        }
      : {
          title: `BrowserHarness couldn't reach ${service}`,
          reason: "The internet may be down, the address may be wrong, or something on this computer (like a firewall or VPN) is blocking it.",
          fixes: ["Check that other websites open.", "If you typed a server address, check it carefully.", "Try again."],
          guide: "ai-cant-reach",
          detail
        };
  }
  if (/empty response|gave no reply|did not return a browserharness action/i.test(detail)) {
    return {
      title: "The AI answered, but with nothing useful",
      reason: "Some models spend their whole answer thinking, or don't follow BrowserHarness's instructions.",
      fixes: ["Try again.", "If it keeps happening, choose another, bigger model."],
      guide: "ai-cant-use-browser",
      detail
    };
  }
  return {
    title: "Something went wrong",
    reason: detail ? "The AI service sent back an error BrowserHarness doesn't recognise." : "BrowserHarness didn't get an answer.",
    fixes: ["Try again.", "If it keeps happening, choose another model or service.", "Show the details below to someone helping you."],
    guide: "something-went-wrong",
    detail
  };
}

/** The AI can chat but failed the browser test. */
export function cantUseBrowser(model: string, error?: unknown): Problem {
  return {
    title: "This AI can chat, but can't use the browser",
    reason: `${model || "This model"} didn't show it knows how to click and type on websites, so tasks on web pages would likely fail. It is saved for chatting.`,
    fixes: ["Choose a bigger or newer model for tasks on websites.", "Press Use this model (or Test and save) again to check it."],
    guide: "ai-cant-use-browser",
    detail: error ? messageOf(error) : undefined
  };
}

/** Nothing to choose from. */
export function noModels(context: AiContext = {}): Problem {
  return context.local
    ? {
        title: `${context.app || "Your AI app"} has no model loaded`,
        reason: "The app is running, but there is no model in it to use.",
        fixes: [`In ${context.app || "the app"}, download a model and load it.`, "Then try again."],
        guide: "ai-no-models"
      }
    : {
        title: "No models were found",
        reason: "The service answered, but listed no models for your account.",
        fixes: ["Type the model name yourself, copied from the service's website.", "Or check your account on the service's website."],
        guide: "ai-no-models"
      };
}

/** Claude Code or Codex isn't installed where the helper app runs. */
export function subscriptionAppMissing(appName: string): Problem {
  return {
    title: `${appName} isn't installed`,
    reason: `Using your plan needs the ${appName} app on the computer where the helper app runs, signed in once.`,
    fixes: [`Install ${appName} from its official website.`, "Open it once and sign in with your account.", "Press Check again."],
    guide: "subscription-app-missing"
  };
}

export type HelperIssue = "not-running" | "not-connected" | "pairing-failed";

/** Problems with the helper app. */
export function diagnoseHelper(issue: HelperIssue, error?: unknown): Problem {
  const detail = error ? messageOf(error) : undefined;
  if (issue === "not-running") {
    return {
      title: "The helper app isn't running",
      reason: "BrowserHarness looked for the helper app on this computer, but it didn't answer. It isn't installed yet, or it was stopped.",
      fixes: [
        "If you haven't yet, install it with the steps above.",
        "If you installed it before, double-click Install BrowserHarness Helper again. It starts the helper app.",
        "Press Pair again."
      ],
      guide: "helper-not-running",
      detail
    };
  }
  if (issue === "not-connected") {
    return {
      title: "The helper app isn't connected",
      reason: "It was paired before, but it isn't running right now, so BrowserHarness can't reach it.",
      fixes: [
        "Double-click Install BrowserHarness Helper again. It starts the helper app and keeps your pairing.",
        "Wait a few seconds. It reconnects by itself.",
        "If it still doesn't, press Pair again."
      ],
      guide: "helper-not-connected",
      detail
    };
  }
  const expired = /expired/i.test(detail || "");
  const declined = /declined/i.test(detail || "");
  return {
    title: "Pairing didn't finish",
    reason: expired
      ? "The code is only valid for 5 minutes, and it ran out."
      : declined
        ? "The pairing was refused on this computer."
        : "The helper app didn't accept the code.",
    fixes: ["Press Pair to get a new code.", "Type all 6 numbers on the setup page in your browser, then press Connect."],
    guide: "helper-pairing-failed",
    detail
  };
}

export type ChatAppId = "telegram" | "discord" | "slack" | "signal" | "mattermost" | "matrix" | "email";

const CHAT_APP_NAME: Record<ChatAppId, string> = {
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
  signal: "Signal",
  mattermost: "Mattermost",
  matrix: "Matrix",
  email: "Your email provider"
};

/** How to get a working code again, for each chat app. */
const NEW_CODE: Record<ChatAppId, string[]> = {
  telegram: [
    "In Telegram, open @BotFather, send /mybots, pick your bot, then press API Token.",
    "Copy the whole code it shows (numbers, a colon, then letters) and paste it again."
  ],
  discord: [
    "Open the Discord Developer Portal, pick your app, then Bot, and press Reset Token.",
    "Copy the new token and paste it again."
  ],
  slack: [
    "Check the first box has the code that starts with xoxb- and the second has the one that starts with xapp-.",
    "If you changed the app on api.slack.com, press Reinstall to Workspace and copy the xoxb- code again."
  ],
  mattermost: [
    "In Mattermost, open Integrations, then Bot Accounts, and make a new token for the bot.",
    "Check the address is the same one you open Mattermost at."
  ],
  matrix: [
    "Sign in to the bot's account in Element, open Settings, then Help & About, and copy the Access Token again.",
    "Check the server address matches the bot's account (for most people, https://matrix.org)."
  ],
  email: [
    "Use an app password made for the bot's mailbox, not the mailbox's normal password.",
    "Gmail and Outlook only offer app passwords after two-step sign-in is turned on for that mailbox."
  ],
  signal: ["Check the number is the bot's spare number, with + and the country code, like +15551234567."]
};

/** Why a chat app couldn't be set up from Settings, and what to do. */
export function diagnoseChatApp(app: ChatAppId, error: unknown): Problem {
  const detail = messageOf(error);
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  const name = CHAT_APP_NAME[app];
  if (code === "BRIDGE_DISCONNECTED" || code === "CHAT_EXTENSION_REQUIRED") return diagnoseHelper("not-connected", error);
  if (code === "CHAT_REQUEST_TIMEOUT") {
    return {
      title: "The helper app didn't answer",
      reason: "It took too long. A slow connection can cause this, and so can an older helper app that can't set up chat apps from here.",
      fixes: [
        "Try again.",
        "If it keeps happening, download the helper app again from Settings, then Helper app, and double-click Install BrowserHarness Helper."
      ],
      guide: "set-up-helper-app",
      detail
    };
  }
  if (code === "CHAT_APPS_UNAVAILABLE" || code === "UNKNOWN_ACTION") {
    return {
      title: "The helper app needs updating",
      reason: "Your helper app is older than this version of BrowserHarness, so it can't set up chat apps from here yet.",
      fixes: ["Download the helper app again from Settings, then Helper app, and double-click Install BrowserHarness Helper.", "Come back here and try again."],
      guide: "set-up-helper-app",
      detail
    };
  }
  if (code === "MISSING_DETAILS") {
    return {
      title: "Some details are missing",
      reason: "Every box above needs to be filled in.",
      fixes: ["Fill in each box, then press Connect again."],
      guide: "set-up-chat-apps",
      detail
    };
  }
  if (code === "EMAIL_SERVERS_UNKNOWN") {
    return {
      title: "BrowserHarness doesn't know this email provider",
      reason: "It knows the mail servers for Gmail, Outlook, Yahoo, iCloud and a few others, but not this one.",
      fixes: [
        "Open “Mail server addresses” below the form.",
        "Copy the incoming (IMAP) and outgoing (SMTP) server names from your email provider's help pages, like imap.example.com:993.",
        "Press Connect again."
      ],
      guide: "set-up-chat-apps",
      detail
    };
  }
  if (app === "signal" && /not found|ENOENT/i.test(detail)) {
    return {
      title: "The Signal program isn't installed",
      reason: "Signal bots need a free program called signal-cli on this computer, and BrowserHarness couldn't find it.",
      fixes: ["Install signal-cli and register the bot's spare number with it, following its guide.", "Then press Connect again."],
      guide: "set-up-chat-apps",
      detail
    };
  }
  if (/unauthori[sz]ed|not found|invalid_auth|not_authed|token_revoked|account_inactive|invalid or expired|access token|AUTHENTICATIONFAILED|invalid credentials|\b535\b|\b40[13]\b|login failed|authentication failed/i.test(detail)) {
    return {
      title: app === "email" ? "The mailbox didn't accept that password" : `${name} didn't accept that code`,
      reason:
        app === "email"
          ? "The email provider said the address or app password is wrong."
          : `${name} said the token is wrong. A letter may be missing, or it was replaced with a new one.`,
      fixes: [...NEW_CODE[app], "Press Connect again."],
      guide: "chat-app-token-rejected",
      detail
    };
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|getaddrinfo|did not answer|timed? ?out|aborted|closed the connection|certificate|network/i.test(detail)) {
    return {
      title: `Couldn't reach ${app === "email" ? "the mail server" : name}`,
      reason: "The helper app on this computer couldn't get through to it. The internet may be down, or an address is mistyped.",
      fixes: [
        "Check this computer is online.",
        app === "mattermost" || app === "matrix"
          ? "Check the server address. Copy it from your browser when Mattermost or Element is open."
          : app === "email"
            ? "If you typed mail server addresses, check them against your provider's help page."
            : "Wait a minute in case the service is having a problem.",
        "Press Connect again."
      ],
      guide: "chat-app-cant-reach",
      detail
    };
  }
  if (code === "BAD_ACCOUNT_ID") {
    return {
      title: "That doesn't look like an account",
      reason: detail,
      fixes: ["The easiest way: send your bot a message, then press Allow next to your name under People waiting."],
      guide: "set-up-chat-apps",
      detail
    };
  }
  return {
    title: "Something went wrong",
    reason: `${name} couldn't be set up.`,
    fixes: ["Check every box is filled in correctly.", "Press Connect again."],
    guide: "something-went-wrong",
    detail
  };
}
