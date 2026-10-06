---
type: guide
status: draft
confidence: high
maturity: automated-verified
aliases: [429, rate limit, too many requests, quota, overloaded]
last_verified: 2026-10-06
slug: ai-busy-or-limit
title: "The AI is busy, or your limit is used up"
summary: "The service is overloaded or your plan's limit is reached."
---

# The AI is busy, or your limit is used up

## Why this happens
- The AI service has too many people using it right now.
- Free plans and new accounts have a limit per minute or per day, and it is reached.

## How to fix it
1. Wait a minute and try again.
2. If it keeps happening, check your plan or credit on the service's website.
3. Add a **Backup AI** under **Settings → Your AI → Which AI does the work**. BrowserHarness then switches to it when the main AI is busy.

## Related
- [[knowledge/help/ai-too-slow]]
- [[knowledge/help/connect-your-ai]]

## Sources
- [[sources/internal/browserharness-product-repo]]: `apps/extension/src/help/problems.ts` and the Settings pages under `apps/extension/src/ui/settings/` (checked 2026-10-06). Behaviour verified by the automated Chromium checks `npm run smoke:settings` and `npm run smoke:connect`, not yet on real user machines.
