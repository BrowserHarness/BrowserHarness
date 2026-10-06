---
type: guide
status: draft
confidence: high
maturity: automated-verified
aliases: [telegram bot, slack bot, discord bot, phone tasks, chat apps, allow someone]
last_verified: 2026-10-06
slug: set-up-chat-apps
title: "Send tasks from your phone"
summary: "Make your own private bot in Telegram or another chat app, and allow only yourself."
---

# Send tasks from your phone

Message your own private bot, like “check my inbox for invoices”. BrowserHarness does the task in Chrome on your computer and replies with the result. Your computer must be on with Chrome open.

## Before you start
- The helper app is installed and shows **Connected** in **Settings → Helper app**.
- Your AI is connected in **Settings → Your AI**.

## Set up your bot
1. Open **Settings → Phone & chat apps**.
2. Under **Set up a chat app**, pick an app. **Telegram** is the easiest.
3. Follow the steps shown for that app to make a bot. At the end the app gives you a long secret code, called a token.
4. Paste it in the box and press **Connect**. BrowserHarness checks it with the app, and shows a green tick and your bot's name.

The token is kept only on your computer, by the helper app. It is never shown again, and never leaves your computer except to talk to the chat app.

## Allow yourself
Your bot is private: it only works for the people you allow.
1. From your phone, send your bot any message, like “hi”.
2. The bot replies that it is private. In **Phone & chat apps**, your name appears under **People waiting**.
3. Press **Allow** next to your name. Now send your bot a task.

For **email** and **Matrix**, type your own address under **Add a person** and press **Allow** instead.

To let a family member use your bot, have them message it, then press **Allow** next to their name. To stop someone, press **Remove** next to their name.

## Each app
- **Telegram:** in Telegram, message **@BotFather** (it has a blue tick), send `/newbot`, and pick a name. It replies with the token.
- **Discord:** on the Discord Developer Portal, make a **New Application**, open **Bot**, press **Reset Token** and copy it. After you press Connect, open the invite link shown to add the bot to a server you own.
- **Slack:** on api.slack.com/apps, make an app, turn on **Socket Mode** (that gives the code starting with `xapp-`), add the permissions shown in Settings, and install it (that gives the code starting with `xoxb-`). Paste both.
- **Mattermost:** in **Integrations → Bot Accounts**, add a bot and copy its token. Also type the address you open Mattermost at.
- **Matrix:** make a separate account for the bot, copy its access token from Element (**Settings → Help & About**), and type its server address.
- **Email:** make a new mailbox just for the bot, turn on two-step sign-in, and make an **app password**. For providers BrowserHarness doesn't know, open **Mail server addresses** and type them from your provider's help page.
- **Signal:** needs a spare phone number and the free program signal-cli installed on this computer, with the number registered in it. Then type the number.

## Turn an app off
Press **Turn off** in that app's panel. The bot stops answering and BrowserHarness forgets its token. You can set it up again any time.

## For people who use a terminal
The same things work with commands, like `browserharness-bridge telegram setup --token <token>` and `browserharness-bridge telegram allow <id>`. Voice notes are still turned on with `browserharness-bridge voice setup`.

## Related
- [[knowledge/help/chat-app-token-rejected]]
- [[knowledge/help/chat-app-cant-reach]]
- [[knowledge/help/set-up-helper-app]]

## Sources
- [[sources/internal/browserharness-product-repo]]: `apps/extension/src/ui/settings/PhonePage.tsx`, `apps/extension/src/help/problems.ts` and `apps/bridge/src/chat-manager.mjs` (checked 2026-10-06). Behaviour verified by the automated Chromium check `npm run smoke:phone` with stand-in chat services, not yet with real Telegram, Slack or other accounts.
