---
type: guide
status: draft
confidence: high
maturity: automated-verified
aliases: [unknown error]
last_verified: 2026-10-06
slug: something-went-wrong
title: "Something went wrong"
summary: "An error BrowserHarness doesn't recognise yet."
---

# Something went wrong

BrowserHarness got an error it doesn't have a plain explanation for yet.

## What to try
1. Try again.
2. Choose another model or service under **Settings → Your AI**.
3. If it keeps happening, open **Show details for someone helping you** under the message and share that text with whoever helps you.

## Related
- [[knowledge/help/connect-your-ai]]

## Sources
- [[sources/internal/browserharness-product-repo]]: `apps/extension/src/help/problems.ts` and the Settings pages under `apps/extension/src/ui/settings/` (checked 2026-10-06). Behaviour verified by the automated Chromium checks `npm run smoke:settings` and `npm run smoke:connect`, not yet on real user machines.
