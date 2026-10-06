# Use BrowserHarness from Discord, Slack or Signal

Message your own bot, like "check my inbox for invoices", and BrowserHarness
does it in Chrome on your computer and replies with the result. Anything that
needs your approval (paying, sending, deleting) stops and waits for you at the
computer. Telegram works the same way: see [TELEGRAM.md](TELEGRAM.md).

You need: the BrowserHarness Bridge installed and paired (see
[CODING-AGENTS.md](CODING-AGENTS.md)), Chrome open, and an AI model connected
in BrowserHarness.

Every app works the same way once it is set up:
1. Message the bot. Because it doesn't know you yet, it replies with a command
   like `browserharness-bridge discord allow 123456789`.
2. Run that command on your computer. Only accounts you allow this way can use
   the bot; everyone else gets a "this bot is private" reply.
3. Message it a task. It replies "On it", then the result. You can also run a
   saved Skill: `/find-red-shoes size 9`. Every task also appears in
   BrowserHarness → History, marked with the app it came from.

Tokens stay in `~/.browserharness-bridge/config.json` on your computer. Keep
them private: anyone with a bot's token can read its messages.

## Discord
1. Open the [Discord Developer Portal](https://discord.com/developers/applications),
   choose **New Application**, give it a name, then open **Bot** and choose
   **Reset Token**. Copy the token.
2. On your computer:
   ```
   browserharness-bridge discord setup --token <the bot token>
   ```
   It answers with an `invite` link. Open it and add the bot to a server you
   own (Discord only lets you message bots you share a server with).
3. Send the bot a direct message and allow your account as described above.

In a server channel, mention the bot (`@YourBot find flights to Goa`); it
ignores everything else said there. No special Discord permissions or
"privileged intents" are needed.

## Slack
1. Open [api.slack.com/apps](https://api.slack.com/apps) and choose
   **Create New App → From scratch**.
2. **Socket Mode**: turn it on and create an app-level token with the
   `connections:write` scope. Copy it (it starts with `xapp-`). Socket Mode
   means nothing on your computer has to be reachable from the internet.
3. **OAuth & Permissions → Bot Token Scopes**: add `chat:write`,
   `im:history` and `app_mentions:read`.
4. **Event Subscriptions**: turn them on and subscribe to the bot events
   `message.im` and `app_mention`.
5. **App Home**: turn on the Messages tab and allow people to send messages
   from it.
6. **Install to Workspace**, then copy the **Bot User OAuth Token** (it starts
   with `xoxb-`).
7. On your computer:
   ```
   browserharness-bridge slack setup --bot-token xoxb-… --app-token xapp-…
   ```
8. Send the app a direct message in Slack and allow your account (your member
   id starts with `U`).

In a channel, mention the app (`@BrowserHarness check prices`) after inviting
it there.

## Signal
Signal has no bot accounts, so the Bridge talks to Signal through
[signal-cli](https://github.com/AsamK/signal-cli), the open-source Signal
client, using a spare phone number for the bot.
1. Install signal-cli by following its README.
2. Register the spare number once (Signal sends it a code; registration may ask
   for a captcha, which signal-cli explains):
   ```
   signal-cli -a +15551234567 register
   signal-cli -a +15551234567 verify 123-456
   ```
3. On your computer:
   ```
   browserharness-bridge signal setup --number +15551234567
   ```
   Add `--command /path/to/signal-cli` if it is not on your PATH.
4. From your own phone, send a Signal message to that number and allow your
   number as described above.

The bot answers one-to-one messages only, not groups. While the Bridge runs it
uses signal-cli for that number, so don't run another signal-cli for the same
number at the same time.

## Not yet
- **WhatsApp**: its official API sends messages to a public web address, which
  a computer at home doesn't have, and needs a Meta business account.
- **Email**: planned; it needs a mail library the Bridge doesn't include yet.

## Commands
- `browserharness-bridge chats`: every app at a glance (never shows tokens)
- `browserharness-bridge <app> status`: the bot and the allowed accounts
- `browserharness-bridge <app> allow <id>`: allow another account
- `browserharness-bridge <app> off`: turn the bot off and forget its token

`<app>` is `telegram`, `discord`, `slack` or `signal`.
