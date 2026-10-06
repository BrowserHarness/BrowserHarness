---
type: guide
status: draft
confidence: high
maturity: automated-verified
aliases: [lm studio, ollama, local model not found, no local model]
last_verified: 2026-10-06
slug: local-ai-not-running
title: "LM Studio or Ollama isn't answering"
summary: "The AI app on your computer is closed or its server isn't started."
---

# LM Studio or Ollama isn't answering

BrowserHarness looks for LM Studio and Ollama on your computer, but nothing answered.

## How to fix it
1. Open **LM Studio** or **Ollama**.
2. In LM Studio, open the **Developer** tab and press **Start Server**. Ollama starts its server by itself.
3. Make sure a model is downloaded and loaded.
4. In **Settings → Your AI**, press **Look again**.

## If your app uses a different address
LM Studio normally answers at `http://127.0.0.1:1234` and Ollama at `http://127.0.0.1:11434`. If your app shows another address, open **My AI app shows a different address**, type it, and press **Look again**.

## Related
- [[knowledge/help/ollama-blocked]]
- [[knowledge/help/ai-no-models]]
- [[knowledge/help/ai-too-slow]]

## Sources
- [[sources/internal/browserharness-product-repo]]: `apps/extension/src/help/problems.ts` and the Settings pages under `apps/extension/src/ui/settings/` (checked 2026-10-06). Behaviour verified by the automated Chromium checks `npm run smoke:settings` and `npm run smoke:connect`, not yet on real user machines.
