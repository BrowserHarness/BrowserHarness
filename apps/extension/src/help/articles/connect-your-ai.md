---
type: guide
status: draft
confidence: high
maturity: automated-verified
aliases: [connect an ai, add a model, set up ai]
last_verified: 2026-10-06
slug: connect-your-ai
title: "Connect your AI"
summary: "How to give BrowserHarness an AI to work with, step by step."
---

# Connect your AI

BrowserHarness needs an AI, the "brain" that understands your request and decides what to click and type. You only connect one once. Open **Settings → Your AI** and pick one of these.

## The easiest way: OpenRouter
1. Press **Connect** next to OpenRouter. A small OpenRouter window opens.
2. Sign in, or make a free account, and press **Authorize**. Add a little credit if it asks.
3. Back in BrowserHarness, pick a model from the list and press **Use this model**.
4. BrowserHarness checks the AI really works. When you see the green tick and **Connected**, you're done.

You pay OpenRouter only for what you use.

## A free AI on your own computer
1. Install **LM Studio** (lmstudio.ai) or **Ollama** (ollama.com) and download a model in it.
2. In LM Studio, open the **Developer** tab and press **Start Server**. Ollama starts by itself.
3. In BrowserHarness, press **Look again**, pick the model and press **Use this model**.

Nothing leaves your computer this way, but you need a fairly powerful computer, and small models struggle with harder tasks.

## Other ways
Under **More ways to connect** you can paste a secret key (API key) from OpenAI, Anthropic, NVIDIA and others, use your own AI server, or use a Claude or ChatGPT subscription through the helper app.

## How you know it worked
A green tick with **Connected** appears, and the AI shows under **Your AI right now** as **Ready to do tasks**. If it can only chat, you'll see an orange note: pick a bigger model for tasks on websites.

## Related
- [[knowledge/help/ai-key-rejected]]
- [[knowledge/help/local-ai-not-running]]
- [[knowledge/help/ai-cant-use-browser]]
- [[knowledge/help/openrouter-sign-in]]

## Sources
- [[sources/internal/browserharness-product-repo]]: `apps/extension/src/help/problems.ts` and the Settings pages under `apps/extension/src/ui/settings/` (checked 2026-10-06). Behaviour verified by the automated Chromium checks `npm run smoke:settings` and `npm run smoke:connect`, not yet on real user machines.
