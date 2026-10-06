# Use BrowserHarness from Discord, Slack, Signal, Mattermost, Matrix or email

Message your own bot, like "check my inbox for invoices", and BrowserHarness
does it in Chrome on your computer and replies with the result. Anything that
needs your approval (paying, sending, deleting) stops and waits for you at the
computer. Telegram works the same way: see [TELEGRAM.md](TELEGRAM.md).

You need: the BrowserHarness Bridge installed and paired (see
[CODING-AGENTS.md](CODING-AGENTS.md)), Chrome open, and an AI model connected
in BrowserHarness.

> **Easiest: no commands.** In BrowserHarness, open **Settings → Phone & chat
> apps**, pick the app, paste the bot's token and press **Connect**. When you
> message your bot, you appear under **People waiting**: press **Allow**. The
> commands below do the same from a terminal.

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

## Scheduled tasks that report to your chat
Send your bot `/schedule every weekday at 8am check my inbox for invoices`.
It saves the schedule on your computer and sends each result back to the same
chat. In BrowserHarness you can also add "and send it to Telegram" (or
Discord, Slack, Signal) to a `/schedule` request, or pick **Also send results
to** under History → Scheduled. The task still runs in Chrome on your computer,
so Chrome and the Bridge need to be running at that time.

## Commands in the chat
Besides tasks, the bot answers these at once:
- `/status`: what's running now and the next scheduled tasks
- `/stop`: stop the tasks you started from this app
- `/schedules`: your scheduled tasks, numbered
- `/unschedule 2`: turn off the second one (turn it back on, or delete it,
  under History → Scheduled)
- `/help`: what the bot can do

## Voice notes
Send your bot a voice note instead of typing. The Bridge turns it into words
with a speech-to-text service you choose, runs the words as the task, and the
bot replies "On it (from your voice note): …" so you can see what it heard.
Only voice notes from accounts you allowed are ever downloaded.

Any service with an OpenAI-style `/audio/transcriptions` address works: a
hosted one with your own API key, or one running on your computer (then
nothing leaves it). BrowserHarness never picks the service or the model for
you:
```
browserharness-bridge voice setup --url https://your-service.example/v1 --model <its speech-to-text model> --key <your API key>
```
Add `--language en` (or another language code) if the service guesses wrong.
Setup sends one second of silence to check the address, model and key. Plain
`http://` only works for a service on this computer. `voice status` shows the
settings without the key, and `voice off` turns voice notes off.

Voice notes work in Telegram, Discord (direct messages), Slack (add the
`files:read` scope), Mattermost, Matrix and Signal, up to 20 MB each. Replies
are text.

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
   `im:history` and `app_mentions:read` (and `files:read` for voice notes).
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

## Mattermost
1. In Mattermost, open **Integrations → Bot Accounts → Add Bot Account** (an
   admin may need to turn bot accounts on), and copy its access token.
2. On your computer:
   ```
   browserharness-bridge mattermost setup --server https://chat.example.com --token <the bot's token>
   ```
3. Send the bot a direct message and allow your account as described above.

In a channel, mention the bot (`@harness check prices`).

## Matrix (Element and other apps)
1. Make a separate Matrix account for the bot and copy its access token (in
   Element: **Settings → Help & About → Access Token**).
2. On your computer:
   ```
   browserharness-bridge matrix setup --homeserver https://matrix.org --token <the bot's token>
   browserharness-bridge matrix allow @you:matrix.org
   ```
3. Start a room with the bot **with encryption turned off** and invite it. It
   joins only rooms that accounts you allowed invite it to, and it can't read
   encrypted rooms.

## Email
Use a separate mailbox for the bot, because it marks the mail it reads as read
and replies from it.
1. Turn on two-step sign-in for that mailbox and make an **app password**
   (Gmail: Google Account → Security → App passwords).
2. On your computer:
   ```
   browserharness-bridge email setup --address mybot@gmail.com --password <app password>
   browserharness-bridge email allow you@example.com
   ```
   Gmail, Outlook, iCloud, Yahoo, Fastmail and Zoho are known. For other
   providers add `--imap host:993 --smtp host:465` (or `:587`).
3. Email the bot a task. Mail that was already in the mailbox is never run.

A From line is easy to fake, so the bot only acts on mail that your mail
provider confirms really came from that address (it checks the provider's
`Authentication-Results`). Mail from big providers passes; mail from a
misconfigured domain is ignored and noted in `browserharness-bridge logs`.

## Not yet
- **WhatsApp**: its official API sends messages to a public web address, which
  a computer at home doesn't have, and needs a Meta business account.

## Commands
- `browserharness-bridge chats`: every app at a glance (never shows tokens)
- `browserharness-bridge <app> status`: the bot and the allowed accounts
- `browserharness-bridge <app> allow <id>`: allow another account
- `browserharness-bridge <app> off`: turn the bot off and forget its token
- `browserharness-bridge voice setup|status|off`: voice notes (see above)

`<app>` is `telegram`, `discord`, `slack`, `signal`, `mattermost`, `matrix` or `email`.
