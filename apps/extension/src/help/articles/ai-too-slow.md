---
type: guide
status: draft
confidence: high
maturity: automated-verified
aliases: [timeout, timed out, slow]
last_verified: 2026-10-06
slug: ai-too-slow
title: "The AI took too long to answer"
summary: "The AI didn't answer in time."
---

# The AI took too long to answer

## Why this happens
- AIs running on your own computer can be slow, especially big models, or the first answer after a model loads.
- An online service can be busy or having a problem.

## How to fix it
1. If the AI runs on your computer, check LM Studio or Ollama is still open and the model is loaded.
2. Try again. The second answer is often faster.
3. Choose a smaller model, or an online service, if it stays slow.

BrowserHarness waits up to two minutes for AIs on your computer.

## Related
- [[knowledge/help/local-ai-not-running]]
- [[knowledge/help/ai-busy-or-limit]]

## Sources
- [[sources/internal/browserharness-product-repo]]: `apps/extension/src/help/problems.ts` and the Settings pages under `apps/extension/src/ui/settings/` (checked 2026-10-06). Behaviour verified by the automated Chromium checks `npm run smoke:settings` and `npm run smoke:connect`, not yet on real user machines.
