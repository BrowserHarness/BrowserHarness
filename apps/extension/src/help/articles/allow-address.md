---
type: guide
status: draft
confidence: high
maturity: automated-verified
aliases: [permission, grant access, custom endpoint]
last_verified: 2026-10-06
slug: allow-address
title: "Chrome didn't allow BrowserHarness to reach this address"
summary: "Chrome asks before an extension talks to a new address."
---

# Chrome didn't allow BrowserHarness to reach this address

When you use your own AI server or an AI app on your computer, Chrome asks once whether BrowserHarness may talk to that address. If the answer was no, or the question was closed, BrowserHarness can't reach it.

## How to fix it
1. Press the button again (**Use this model**, **Test and save** or **Allow BrowserHarness to reach this address**).
2. When Chrome asks, choose **Allow**.

BrowserHarness only talks to that address to reach your AI.

## Related
- [[knowledge/help/ai-cant-reach]]
- [[knowledge/help/local-ai-not-running]]

## Sources
- [[sources/internal/browserharness-product-repo]]: `apps/extension/src/help/problems.ts` and the Settings pages under `apps/extension/src/ui/settings/` (checked 2026-10-06). Behaviour verified by the automated Chromium checks `npm run smoke:settings` and `npm run smoke:connect`, not yet on real user machines.
