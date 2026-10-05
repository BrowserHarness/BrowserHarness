# Subscription adapters (ChatGPT and Claude plans, no API key)

BrowserHarness can run on the ChatGPT or Claude subscription a user already pays for, in addition to API keys.

## How it works

```
Side panel (model client)
   ↓ BRIDGE_LLM (extension pages only)
Service worker
   ↓ llm_request over the paired Bridge WebSocket
Local Bridge  ──spawns──▶  official vendor CLI, tools disabled
   ↑ llm_result (text)
```

- **Claude subscription** → `claude_cli`: the Claude Code CLI (`claude -p --output-format json --tools "" --no-session-persistence --disable-slash-commands --setting-sources ""`). Verified against a real `claude` 2.1.289 install.
- **ChatGPT subscription** → `codex_cli`: the Codex CLI (`codex exec --skip-git-repo-check --sandbox read-only --color never --output-last-message <file> -`). Written from the documented flags and covered by a fake-CLI test, **not yet verified against a real Codex install**. If a flag differs on your version, only `apps/bridge/src/llm-adapters.mjs` needs changing.

The user installs and signs in to the vendor's own CLI once. BrowserHarness never reads, copies or forwards the vendor's login tokens.

## Safety properties

- The extension names an adapter id and a model name only. Command lines are fixed in the Bridge; models are validated against a strict pattern. Unknown adapters are rejected.
- Only the paired extension may send `llm_request`; the service worker only accepts `BRIDGE_LLM` from extension pages, not content scripts.
- The CLI runs in a throwaway empty working directory, with its tools disabled (Claude) or a read-only sandbox (Codex), so it cannot touch project files or act on the machine. The page-control tools stay inside BrowserHarness, under its approvals.
- Limits: 400k-character prompts, 200k-character output, 2 concurrent requests, hard timeout (default 120 s, max 300 s), process killed on timeout or cancel.
- Override the executable per machine with `BROWSERHARNESS_CLAUDE_COMMAND` / `BROWSERHARNESS_CODEX_COMMAND` (Bridge environment).

## Limits users will notice

- Text only: no screenshots, no embeddings.
- Slower per step than an API call (a CLI starts for each request).
- Requires the Local Agent Bridge to be running and connected.
- Subject to the vendor's own plan limits and terms; use the vendor's official client as intended.

## Not built (deliberately)

- Driving the user's logged-in chatgpt.com or claude.ai tab as a model. It is fragile and sits in a terms-of-service grey area, so it is not part of this change.
- Reusing consumer login tokens in BrowserHarness itself.

## Local verification

`npm test` (Bridge adapter tests with fake CLIs, extension transport tests) and `npm run smoke:subscription` (real Chromium → Bridge → fake CLI, agent loop end to end).
