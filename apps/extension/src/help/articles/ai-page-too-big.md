---
type: guide
status: draft
confidence: high
maturity: automated-verified
aliases: [context window, context length, too many tokens]
last_verified: 2026-10-06
slug: ai-page-too-big
title: "The page is too big for this AI"
summary: "The model can't read that much text at once."
---

# The page is too big for this AI

Every AI can only read a certain amount of text at once. Some web pages are longer than that.

## How to fix it
- If the AI runs on your computer: in LM Studio or Ollama, load the model again with a bigger **context length** (16,000 or more).
- Or choose a bigger model that can read more at once.

## Related
- [[knowledge/help/ai-cant-use-browser]]

## Sources
- [[sources/internal/browserharness-product-repo]]: `apps/extension/src/help/problems.ts` and the Settings pages under `apps/extension/src/ui/settings/` (checked 2026-10-06). Behaviour verified by the automated Chromium checks `npm run smoke:settings` and `npm run smoke:connect`, not yet on real user machines.
