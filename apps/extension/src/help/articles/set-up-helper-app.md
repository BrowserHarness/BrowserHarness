---
type: guide
status: draft
confidence: high
maturity: automated-verified
aliases: [bridge, local bridge, pair, helper app]
last_verified: 2026-10-06
slug: set-up-helper-app
title: "Set up the helper app"
summary: "Install the small helper program and pair it with Chrome."
---

# Set up the helper app

The helper app is a small free program on your computer. You only need it to send tasks from your phone (Telegram and other chat apps), to use a Claude or ChatGPT subscription, or to let coding tools like Claude Code use your browser.

## Install it
1. Install **Node.js** from nodejs.org if your computer doesn't have it. Choose the version marked **LTS**.
2. Unzip the helper app download (a file named `browserharness-bridge…zip`).
3. On Windows, double-click **install.cmd**. On a Mac or Linux, open Terminal in that folder and type `bash install.sh`.

## Pair it with Chrome
1. In BrowserHarness, open **Settings → Helper app** and press **Pair**.
2. Six numbers appear. Type them into the installer window and press Enter.
3. A green tick and **Connected** appear.

To pair again later, type `browserharness-bridge pair` in a terminal and press Pair in BrowserHarness.

## Check it is running
Type `browserharness-bridge status` in a terminal. It says whether the helper app is running and whether Chrome is connected.

## Related
- [[knowledge/help/helper-not-running]]
- [[knowledge/help/helper-not-connected]]
- [[knowledge/help/helper-pairing-failed]]

## Sources
- [[sources/internal/browserharness-product-repo]]: `apps/extension/src/help/problems.ts` and the Settings pages under `apps/extension/src/ui/settings/` (checked 2026-10-06). Behaviour verified by the automated Chromium checks `npm run smoke:settings` and `npm run smoke:connect`, not yet on real user machines.
