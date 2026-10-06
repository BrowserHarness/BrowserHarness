---
type: guide
status: draft
confidence: high
maturity: automated-verified
aliases: [claude subscription, chatgpt subscription, codex, claude code]
last_verified: 2026-10-06
slug: subscription-app-missing
title: "Claude Code or Codex isn't installed"
summary: "Using your Claude or ChatGPT plan needs their app on your computer."
---

# Claude Code or Codex isn't installed

To use your Claude or ChatGPT plan instead of a secret key, BrowserHarness talks to the official app (Claude Code or Codex) through the helper app. That app must be installed on the same computer and signed in once.

## How to fix it
1. Make sure the helper app is installed and paired (see **Set up the helper app**).
2. Install **Claude Code** (for a Claude plan) or **Codex** (for a ChatGPT plan) from the official website.
3. Open it once and sign in with your account.
4. In **Settings → Your AI → More ways to connect**, press **Check again**.

BrowserHarness never sees your login. Answers are slower than with a secret key, and it can't look at screenshots.

## Related
- [[knowledge/help/set-up-helper-app]]
- [[knowledge/help/helper-not-connected]]

## Sources
- [[sources/internal/browserharness-product-repo]]: `apps/extension/src/help/problems.ts` and the Settings pages under `apps/extension/src/ui/settings/` (checked 2026-10-06). Behaviour verified by the automated Chromium checks `npm run smoke:settings` and `npm run smoke:connect`, not yet on real user machines.
