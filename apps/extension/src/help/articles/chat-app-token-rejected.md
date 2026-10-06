---
type: guide
status: draft
confidence: high
maturity: automated-verified
aliases: [telegram unauthorized, invalid_auth, bot token wrong, app password rejected]
last_verified: 2026-10-06
slug: chat-app-token-rejected
title: "The chat app didn't accept the code"
summary: "The bot's token, or the mailbox's app password, was refused."
---

# The chat app didn't accept the code

## Why this happens
- Part of the token was missed when copying, or a space was added.
- The token was replaced with a new one (for example after **Reset Token**), so the old one stopped working.
- For Slack, the two codes were swapped: the `xoxb-` code goes in the first box and the `xapp-` code in the second.
- For email, the mailbox's normal password was used instead of an app password.

## How to fix it
1. Get the code again:
   - **Telegram:** open **@BotFather**, send `/mybots`, pick your bot, then **API Token**.
   - **Discord:** Developer Portal, your app, **Bot**, **Reset Token**.
   - **Slack:** api.slack.com/apps, your app. The `xapp-` code is under **Basic Information → App-Level Tokens**; the `xoxb-` code is under **OAuth & Permissions**. If you changed the app, press **Reinstall to Workspace** first.
   - **Mattermost:** **Integrations → Bot Accounts**, make a new token.
   - **Matrix:** in Element, signed in as the bot, **Settings → Help & About → Access Token**.
   - **Email:** make a new app password for the bot's mailbox. Two-step sign-in must be on first.
2. Paste it with nothing before or after it.
3. Press **Connect** again and wait for the green tick.

## Related
- [[knowledge/help/set-up-chat-apps]]
- [[knowledge/help/chat-app-cant-reach]]

## Sources
- [[sources/internal/browserharness-product-repo]]: `apps/extension/src/ui/settings/PhonePage.tsx`, `apps/extension/src/help/problems.ts` and `apps/bridge/src/chat-manager.mjs` (checked 2026-10-06). Behaviour verified by the automated Chromium check `npm run smoke:phone` with stand-in chat services, not yet with real Telegram, Slack or other accounts.
