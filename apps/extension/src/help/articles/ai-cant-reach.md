---
type: guide
status: draft
confidence: high
maturity: automated-verified
aliases: [failed to fetch, network error, connection refused]
last_verified: 2026-10-06
slug: ai-cant-reach
title: "BrowserHarness couldn't reach the AI service"
summary: "No answer from the service's address."
---

# BrowserHarness couldn't reach the AI service

## Why this happens
- The internet connection is down.
- The server address you typed is wrong.
- A firewall, VPN or office network blocks the address.

## How to fix it
1. Check that other websites open.
2. If you typed a **Server address**, check it carefully. It usually ends in `/v1`, for example `https://api.groq.com/openai/v1`.
3. If you're on a work network or VPN, try without it, or ask whoever runs it.
4. Press **Test and save** again.

## Related
- [[knowledge/help/allow-address]]
- [[knowledge/help/local-ai-not-running]]

## Sources
- [[sources/internal/browserharness-product-repo]]: `apps/extension/src/help/problems.ts` and the Settings pages under `apps/extension/src/ui/settings/` (checked 2026-10-06). Behaviour verified by the automated Chromium checks `npm run smoke:settings` and `npm run smoke:connect`, not yet on real user machines.
