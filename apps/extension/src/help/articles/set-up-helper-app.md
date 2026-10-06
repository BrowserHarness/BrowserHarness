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
1. Get the helper app for your computer from the same place you got BrowserHarness. Nothing else needs installing first: it brings everything it needs.
   - Mac with an Apple chip (M1 or newer): `browserharness-helper-mac-apple.zip`
   - Mac with an Intel chip: `browserharness-helper-mac-intel.zip`
   - Windows 10 or 11: `browserharness-helper-windows.zip`
   - Linux: `browserharness-helper-linux.zip`
2. Open the download. On Windows, unzip it first (right-click, then **Extract All**).
3. Double-click **Install BrowserHarness Helper**. A small window opens, and a setup page opens in your browser.

## If your computer says it can't check the app
The helper app isn't signed with an Apple or Microsoft certificate yet, so your computer asks first.
- **Mac:** close the message, open **System Settings → Privacy & Security**, scroll down and press **Open Anyway**.
- **Windows:** press **More info**, then **Run anyway**.
- **Linux:** right-click the file and choose **Run as a program**.

## Pair it with Chrome
1. In BrowserHarness, open **Settings → Helper app** and press **Pair**.
2. Six numbers appear. Type them on the setup page in your browser and press **Connect**.
3. The page and BrowserHarness both show a green tick and **Connected**. You can close the page and the small window, and delete the download.

The helper app starts by itself when you turn on your computer. To pair again later, double-click **Install BrowserHarness Helper** again.

## For people who use a terminal
If you already have Node.js 20 or newer, the small download (`browserharness-bridge…zip`) installs with `bash install.sh`. `browserharness-bridge setup` opens the setup page again, and `browserharness-bridge status` says whether it is running and whether Chrome is connected.

## Related
- [[knowledge/help/helper-not-running]]
- [[knowledge/help/helper-not-connected]]
- [[knowledge/help/helper-pairing-failed]]

## Sources
- [[sources/internal/browserharness-product-repo]]: `apps/extension/src/help/problems.ts` and the Settings pages under `apps/extension/src/ui/settings/` (checked 2026-10-06). Behaviour verified by the automated Chromium checks `npm run smoke:settings` and `npm run smoke:connect`, not yet on real user machines.
