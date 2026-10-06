---
type: guide
status: draft
confidence: high
maturity: automated-verified
aliases: [bridge not running, pair failed]
last_verified: 2026-10-06
slug: helper-not-running
title: "The helper app isn't running"
summary: "BrowserHarness looked for the helper app and nothing answered."
---

# The helper app isn't running

## Why this happens
- The helper app isn't installed yet.
- It was installed but has stopped, for example after a restart.

## How to fix it
1. If you haven't installed it, follow **Set up the helper app**.
2. If you have, double-click **Install BrowserHarness Helper** again. It starts the helper app.
3. In **Settings → Helper app**, press **Pair** again if it asks.

## Related
- [[knowledge/help/set-up-helper-app]]
- [[knowledge/help/helper-not-connected]]

## Sources
- [[sources/internal/browserharness-product-repo]]: `apps/extension/src/help/problems.ts` and the Settings pages under `apps/extension/src/ui/settings/` (checked 2026-10-06). Behaviour verified by the automated Chromium checks `npm run smoke:settings` and `npm run smoke:connect`, not yet on real user machines.
