# Connecting an AI to BrowserHarness

Open the side panel → Settings (gear) → Models & connections. The top of the screen has big buttons:

- **OpenRouter (recommended):** press Connect, sign in on OpenRouter's page, approve. Then choose any model from the searchable list (Claude, GPT, Gemini, Qwen, DeepSeek and hundreds more). Pay-as-you-go, no key to copy. This is a real OAuth sign-in, not a ChatGPT or Claude subscription.
- **ChatGPT:** shows "Coming soon" until OpenAI approves BrowserHarness for Sign in with ChatGPT (client ID request: https://developers.openai.com/siwc/request-client-id).
- **A model on this computer:** if LM Studio or Ollama is running, BrowserHarness finds it (at `127.0.0.1` or `localhost`) and lists every model you have loaded. Pick one and press "Use this model". If your server uses another address, type what LM Studio shows (for example `http://127.0.0.1:1234`) and press "Check again".

BrowserHarness never picks a model for you. Once a service is connected, every one of its models is in the **model menu at the top of the chat**: click the model name, search, and click another model to switch, like on claude.ai or chatgpt.com. "Add or manage services…" at the bottom of that menu opens this screen.

Everything below is under "Advanced" and is for people comfortable with keys and terminals. Claude subscriptions cannot be offered as a Connect button because Anthropic does not allow subscription logins in third-party apps.

### Advanced: Add connection. Pick one of three kinds.

## 1. Models on this computer (LM Studio, Ollama) — no API key
- **LM Studio:** load a model, open the Developer tab, start the local server. Provider "LM Studio (local)", base URL `http://127.0.0.1:1234/v1` (default).
- **Ollama:** run `ollama serve` and pull a model. Provider "Ollama (local)", base URL `http://127.0.0.1:11434/v1` (default). If you get a 403, start Ollama with `OLLAMA_ORIGINS=chrome-extension://*`.
- Pick the model from the list (or type its name) and press "Test Chat + Agent & save". BrowserHarness waits up to two minutes per answer because local models can be slow.

## 2. Your ChatGPT or Claude subscription — no API key
1. Install and sign in to the vendor's app once on this computer: Claude Code (for Claude) or the Codex CLI (for ChatGPT).
2. Install the Local Bridge (see [Coding agents](CODING-AGENTS.md)) and press **Pair** under Settings → Helper app.
3. Provider "Claude subscription" or "ChatGPT subscription". The panel shows "Ready" once the Bridge is connected and the app is found. Press "Test Chat + Agent & save".

Text only (no screenshots) and slower per step than an API. Details: `docs/architecture/SUBSCRIPTION-ADAPTERS.md`.

## 3. API key (OpenAI, Anthropic, NVIDIA, or any OpenAI-compatible service)
Paste the key, wait for models to load, pick one, press "Test Chat + Agent & save". Keys stay in Chrome's local extension storage.

## "Not usable for Chat: Model request timed out"
The model did not answer the quick test within 30 seconds (2 minutes for local models). It is usually a busy, cold-starting or reasoning-heavy model, not a bad key. Try again, or choose a faster model (a "flash", "mini" or "instruct" model).

## "Model returned an empty response" or "spent its whole answer thinking"
Thinking models (OpenRouter's auto router, Qwen3, DeepSeek R1 and similar) can use their whole answer budget on reasoning. BrowserHarness asks OpenRouter to keep reasoning short, gives local models a larger budget, hides `<think>` blocks, and retries once with more room. If it still comes back empty, pick another model from the model menu.
