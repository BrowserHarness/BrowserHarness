# Let Claude Code, Codex, Cursor or Hermes use your Chrome

BrowserHarness can be the browser for the coding agent on your computer, the
way Kimi's WebBridge is. The agent works in your own Chrome, with your logins,
and BrowserHarness keeps its approvals and your own tabs protected.

You need Node.js 20 or newer (https://nodejs.org) and one of: Claude Code,
Codex, Cursor or Hermes.

## 1. Install the Bridge (once)
From the Bridge download (the folder with `browserharness-bridge.mjs`):
- **Mac / Linux:** `bash install.sh`
- **Windows:** double-click `install.cmd`
- From this repository: `npm run build:bridge`, then `bash apps/bridge/dist/install.sh`.

The installer:
- starts the Bridge now and every time you log in;
- connects every agent it finds (Claude Code, Codex, Cursor, Hermes) and gives
  each a `browserharness` skill that teaches it how to drive the browser;
- asks for the pairing code (step 2).

## 2. Pair Chrome
In Chrome, open BrowserHarness → Settings → **Coding agents** and press
**Pair**. Type the 6-digit code it shows into the terminal. The side panel then
says **Connected**. To pair later: `browserharness-bridge pair`.

## 3. Use it
Ask your agent, for example: "Use BrowserHarness to find the cheapest flight
from Delhi to Goa next Friday". In Claude Code you can also type
`/browserharness`. Restart the agent once after installing so it loads the new
tools.

Sending, buying, deleting and submitting still need your approval in the
BrowserHarness side panel.

Your saved Skills work here too: ask "use my find-red-shoes Skill" and the
agent reads its steps with `browserharness_skills`.

## Commands
- `browserharness-bridge status`: is the Bridge running and is Chrome connected
- `browserharness-bridge agents`: which agents were found
- `browserharness-bridge pair`: pair Chrome again
- `browserharness-bridge skills`: list your saved Skills
- `browserharness-bridge skill <name> [details]`: print one Skill's steps, ready for any agent or script
- `browserharness-bridge telegram setup --token <token>`: use BrowserHarness from your phone (see [TELEGRAM.md](TELEGRAM.md))
- `browserharness-bridge uninstall`: remove everything the installer added (`--purge` also deletes the token)

If `browserharness-bridge` is not found, use
`node ~/.browserharness-bridge/bin/browserharness-bridge.mjs <command>`.
