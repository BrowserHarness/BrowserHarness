---
type: guide
status: draft
confidence: high
maturity: automated-verified
aliases: [ollama 403, ollama origins, OLLAMA_ORIGINS]
last_verified: 2026-10-06
slug: ollama-blocked
title: "Ollama blocked BrowserHarness"
summary: "Ollama refuses requests from Chrome extensions until you allow them."
---

# Ollama blocked BrowserHarness

Ollama only answers programs it trusts. Out of the box, Chrome extensions aren't on that list, so it answers "403 forbidden".

## How to fix it
1. Quit Ollama (from its icon in the menu bar or system tray).
2. Start it again with extensions allowed. In a terminal, type:
   `OLLAMA_ORIGINS=chrome-extension://* ollama serve`
3. In **Settings → Your AI**, press **Look again**.

On Windows, set `OLLAMA_ORIGINS` to `chrome-extension://*` in **Edit the system environment variables**, then restart Ollama.

## Related
- [[knowledge/help/local-ai-not-running]]

## Sources
- [[sources/internal/browserharness-product-repo]]: `apps/extension/src/help/problems.ts` and the Settings pages under `apps/extension/src/ui/settings/` (checked 2026-10-06). Behaviour verified by the automated Chromium checks `npm run smoke:settings` and `npm run smoke:connect`, not yet on real user machines.
