# Use BrowserHarness from your phone (Telegram)

Send a message to your own Telegram bot, like "check my inbox for invoices",
and BrowserHarness does it in Chrome on your computer and replies with the
result. Anything that needs your approval (paying, sending, deleting) stops
and waits for you at the computer.

You need: the BrowserHarness Bridge installed and paired (see
[CODING-AGENTS.md](CODING-AGENTS.md)), Chrome open, and an AI model connected
in BrowserHarness.

> **Easiest: no commands.** In BrowserHarness, open **Settings → Phone & chat
> apps**, pick the app, paste the bot's token and press **Connect**. When you
> message your bot, you appear under **People waiting**: press **Allow**. The
> commands below do the same from a terminal.

## 1. Make a bot (2 minutes, once)
1. In Telegram, open **@BotFather** and send `/newbot`.
2. Pick a name and a username. BotFather replies with a token like
   `123456789:AAH...`. Keep it private: anyone with it can read your bot's messages.

## 2. Give the token to the Bridge
```
browserharness-bridge telegram setup --token 123456789:AAH...
```
The token stays in `~/.browserharness-bridge/config.json` on your computer.

## 3. Allow your Telegram account
Send any message to your new bot. It answers with a command such as
`browserharness-bridge telegram allow 987654321`. Run it on your computer.
Only accounts you allow this way can use the bot; everyone else gets a
"this bot is private" reply.

## 4. Use it
Message the bot a task. It replies "On it", then the result. You can also run
a saved Skill: `/find-red-shoes size 9`. Every task also appears in
BrowserHarness → History. Send `/status` to see what's running, `/stop` to
stop it, and `/schedules` for your scheduled tasks. Voice notes work too once you choose a
speech-to-text service: see "Voice notes" in [CHAT-APPS.md](CHAT-APPS.md).

## Commands
- `browserharness-bridge telegram status`: the bot and the allowed accounts
- `browserharness-bridge telegram allow <id>`: allow another account
- `browserharness-bridge telegram off`: turn the bot off and forget the token

Discord, Slack, Signal, Mattermost, Matrix and email work the same way, and scheduled tasks can report here: see [CHAT-APPS.md](CHAT-APPS.md).
