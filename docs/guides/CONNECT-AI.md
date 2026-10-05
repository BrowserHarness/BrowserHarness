# Connecting an AI to BrowserHarness

Open the side panel → Settings (gear) → Models & connections → Add connection. Pick one of three kinds.

## 1. Models on this computer (LM Studio, Ollama) — no API key
- **LM Studio:** load a model, open the Developer tab, start the local server. Provider "LM Studio (local)", base URL `http://localhost:1234/v1` (default).
- **Ollama:** run `ollama serve` and pull a model. Provider "Ollama (local)", base URL `http://localhost:11434/v1` (default). If you get a 403, start Ollama with `OLLAMA_ORIGINS=chrome-extension://*`.
- Pick the model from the list (or type its name) and press "Test Chat + Agent & save". BrowserHarness waits up to two minutes per answer because local models can be slow.

## 2. Your ChatGPT or Claude subscription — no API key
1. Install and sign in to the vendor's app once on this computer: Claude Code (for Claude) or the Codex CLI (for ChatGPT).
2. Start the Local Bridge (`node apps/bridge/src/cli.mjs start` from the repo; it prints a pairing token), then paste the token in Settings → Local Agent Bridge and switch it on.
3. Provider "Claude subscription" or "ChatGPT subscription". The panel shows "Ready" once the Bridge is connected and the app is found. Press "Test Chat + Agent & save".

Text only (no screenshots) and slower per step than an API. Details: `docs/architecture/SUBSCRIPTION-ADAPTERS.md`.

## 3. API key (OpenAI, Anthropic, NVIDIA, or any OpenAI-compatible service)
Paste the key, wait for models to load, pick one, press "Test Chat + Agent & save". Keys stay in Chrome's local extension storage.

## "Not usable for Chat: Model request timed out"
The model did not answer the quick test within 30 seconds (2 minutes for local models). It is usually a busy, cold-starting or reasoning-heavy model, not a bad key. Try again, or choose a faster model (a "flash", "mini" or "instruct" model).
