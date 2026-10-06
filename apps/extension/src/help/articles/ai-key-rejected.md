---
type: guide
status: draft
confidence: high
maturity: automated-verified
aliases: [401, unauthorized, invalid api key, 402, payment required, 403]
last_verified: 2026-10-06
slug: ai-key-rejected
title: "The AI service said no to your key"
summary: "Your secret key was refused, or your account needs credit."
---

# The AI service said no to your key

BrowserHarness tried your AI service and it answered "not allowed".

## Why this happens
- The secret key (API key) was copied wrong, with a missing letter or an extra space.
- The key was deleted or replaced on the service's website.
- Your account has no credit left, or needs a payment method first.
- Your account isn't allowed to use that model.

## How to fix it
1. Open your account on the service's website (for example openrouter.ai, platform.openai.com or console.anthropic.com).
2. Check your account has credit.
3. Make a new secret key and copy it with the copy button on that page.
4. In **Settings → Your AI → More ways to connect**, paste it into **Secret key (API key)** with nothing before or after it.
5. Press **Test and save**.

If you connected with the OpenRouter **Connect** button, disconnect OpenRouter under **Services you've connected** and connect again.

## Related
- [[knowledge/help/connect-your-ai]]
- [[knowledge/help/ai-model-not-found]]

## Sources
- [[sources/internal/browserharness-product-repo]]: `apps/extension/src/help/problems.ts` and the Settings pages under `apps/extension/src/ui/settings/` (checked 2026-10-06). Behaviour verified by the automated Chromium checks `npm run smoke:settings` and `npm run smoke:connect`, not yet on real user machines.
