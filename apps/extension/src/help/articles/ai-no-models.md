---
type: guide
status: draft
confidence: high
maturity: automated-verified
aliases: [no models, empty model list]
last_verified: 2026-10-06
slug: ai-no-models
title: "No models were found"
summary: "The service or app answered, but there was nothing to choose."
---

# No models were found

## Why this happens
- In LM Studio or Ollama, no model is downloaded or loaded yet.
- Some services don't list their models. You can still type the name.

## How to fix it
1. In LM Studio or Ollama, download a model and load it, then press **Look again**.
2. For an online service, type the model name copied from its website, then press **Test and save**.

## Related
- [[knowledge/help/local-ai-not-running]]
- [[knowledge/help/ai-model-not-found]]

## Sources
- [[sources/internal/browserharness-product-repo]]: `apps/extension/src/help/problems.ts` and the Settings pages under `apps/extension/src/ui/settings/` (checked 2026-10-06). Behaviour verified by the automated Chromium checks `npm run smoke:settings` and `npm run smoke:connect`, not yet on real user machines.
