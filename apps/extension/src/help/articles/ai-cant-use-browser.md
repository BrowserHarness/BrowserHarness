---
type: guide
status: draft
confidence: high
maturity: automated-verified
aliases: [agent check failed, chat only]
last_verified: 2026-10-06
slug: ai-cant-use-browser
title: "This AI can chat, but can't use the browser"
summary: "The model failed the browser test, so it is saved for chatting only."
---

# This AI can chat, but can't use the browser

When you add an AI, BrowserHarness gives it a small test: choose the right thing to click on a page. This AI could chat but didn't pass that test, so tasks on websites would likely go wrong.

## How to fix it
1. Choose a bigger or newer model. Well-known recent models from large companies usually pass.
2. Press **Use this model** (or **Test and save**) to check it.
3. Make the one that passes your **Main AI** under **Which AI does the work**.

You can keep this AI for chatting. It shows **Can chat** and **Can't use the browser** under **AIs you've tested**.

## Related
- [[knowledge/help/connect-your-ai]]
- [[knowledge/help/ai-page-too-big]]

## Sources
- [[sources/internal/browserharness-product-repo]]: `apps/extension/src/help/problems.ts` and the Settings pages under `apps/extension/src/ui/settings/` (checked 2026-10-06). Behaviour verified by the automated Chromium checks `npm run smoke:settings` and `npm run smoke:connect`, not yet on real user machines.
