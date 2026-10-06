---
type: guide
status: draft
confidence: high
maturity: automated-verified
aliases: [fetch failed, telegram not reachable, mail server did not answer]
last_verified: 2026-10-06
slug: chat-app-cant-reach
title: "Couldn't reach the chat app"
summary: "The helper app couldn't get through to Telegram, Slack, the mail server or your own server."
---

# Couldn't reach the chat app

The check runs from the helper app on your computer, so this is about your computer's internet connection, not Chrome's.

## Why this happens
- This computer is offline, or a firewall or work network blocks the app.
- For Mattermost, Matrix or email: the server address is mistyped.
- The chat service is having a problem right now.

## How to fix it
1. Check this computer is online, for example by opening a website.
2. For Mattermost or Matrix, copy the address from your browser while the app is open (like `https://chat.example.com`) and paste it again.
3. For email, check the mail server addresses against your provider's help page, with the port, like `imap.example.com:993`.
4. Wait a minute and press **Connect** again.

## Related
- [[knowledge/help/set-up-chat-apps]]
- [[knowledge/help/chat-app-token-rejected]]
- [[knowledge/help/helper-not-connected]]

## Sources
- [[sources/internal/browserharness-product-repo]]: `apps/extension/src/ui/settings/PhonePage.tsx`, `apps/extension/src/help/problems.ts` and `apps/bridge/src/chat-manager.mjs` (checked 2026-10-06). Behaviour verified by the automated Chromium check `npm run smoke:phone` with stand-in chat services, not yet with real Telegram, Slack or other accounts.
