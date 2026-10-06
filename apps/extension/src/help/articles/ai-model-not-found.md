---
type: guide
status: draft
confidence: high
maturity: automated-verified
aliases: [404, model not found, unknown model]
last_verified: 2026-10-06
slug: ai-model-not-found
title: "The service doesn't know this model"
summary: "The model name isn't available at that service."
---

# The service doesn't know this model

## Why this happens
- The model name was typed with a small difference, like a missing dash.
- The service removed or renamed the model.
- The model isn't available to your account.

## How to fix it
1. Choose the model from the list instead of typing it.
2. If you must type it, copy the exact name from the service's website.
3. Press **Test and save** again.

## Related
- [[knowledge/help/ai-key-rejected]]
- [[knowledge/help/ai-no-models]]

## Sources
- [[sources/internal/browserharness-product-repo]]: `apps/extension/src/help/problems.ts` and the Settings pages under `apps/extension/src/ui/settings/` (checked 2026-10-06). Behaviour verified by the automated Chromium checks `npm run smoke:settings` and `npm run smoke:connect`, not yet on real user machines.
