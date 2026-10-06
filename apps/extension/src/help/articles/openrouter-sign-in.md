---
type: guide
status: draft
confidence: high
maturity: automated-verified
aliases: [openrouter, sign-in cancelled, authorize]
last_verified: 2026-10-06
slug: openrouter-sign-in
title: "The OpenRouter sign-in didn't finish"
summary: "The OpenRouter window closed before you pressed Authorize."
---

# The OpenRouter sign-in didn't finish

## Why this happens
- The OpenRouter window was closed before you pressed **Authorize**.
- OpenRouter had a problem finishing the connection.

## How to fix it
1. In **Settings → Your AI**, press **Connect** again.
2. Sign in to OpenRouter, or make a free account, in the window that opens.
3. Press **Authorize** and wait. The window closes by itself and a list of models appears.

If it still doesn't work, make an OpenRouter key on openrouter.ai and paste it under **More ways to connect** instead.

## Related
- [[knowledge/help/connect-your-ai]]
- [[knowledge/help/ai-key-rejected]]

## Sources
- [[sources/internal/browserharness-product-repo]]: `apps/extension/src/help/problems.ts` and the Settings pages under `apps/extension/src/ui/settings/` (checked 2026-10-06). Behaviour verified by the automated Chromium checks `npm run smoke:settings` and `npm run smoke:connect`, not yet on real user machines.
