---
type: guide
status: draft
confidence: high
maturity: automated-verified
aliases: [bridge disconnected, helper offline]
last_verified: 2026-10-06
slug: helper-not-connected
title: "The helper app isn't connected"
summary: "It was paired before but isn't reachable right now."
---

# The helper app isn't connected

## Why this happens
The helper app was paired, but it isn't running right now, so chat apps, subscriptions and coding tools can't work.

## How to fix it
1. Double-click **Install BrowserHarness Helper** again. It starts the helper app and keeps your pairing.
2. Wait a few seconds. BrowserHarness reconnects by itself, and **Settings → Helper app** shows **Connected**.
3. If it doesn't, press **Pair** again and type the code on the setup page.

## Related
- [[knowledge/help/helper-not-running]]
- [[knowledge/help/set-up-helper-app]]

## Sources
- [[sources/internal/browserharness-product-repo]]: `apps/extension/src/help/problems.ts` and the Settings pages under `apps/extension/src/ui/settings/` (checked 2026-10-06). Behaviour verified by the automated Chromium checks `npm run smoke:settings` and `npm run smoke:connect`, not yet on real user machines.
