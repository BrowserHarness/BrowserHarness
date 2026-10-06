---
type: guide
status: draft
confidence: high
maturity: automated-verified
aliases: [pairing code expired, pairing declined]
last_verified: 2026-10-06
slug: helper-pairing-failed
title: "Pairing didn't finish"
summary: "The 6-number code ran out or wasn't accepted."
---

# Pairing didn't finish

## Why this happens
- The code is valid for 5 minutes, and it ran out.
- A wrong number was typed.
- The pairing was refused on this computer.

## How to fix it
1. In **Settings → Helper app**, press **Pair** to get a new code.
2. Type all 6 numbers on the setup page in your browser and press **Connect**. If the setup page is closed, double-click **Install BrowserHarness Helper** again to open it.
3. Wait for the green tick and **Connected**.

## Related
- [[knowledge/help/helper-not-running]]
- [[knowledge/help/set-up-helper-app]]

## Sources
- [[sources/internal/browserharness-product-repo]]: `apps/extension/src/help/problems.ts` and the Settings pages under `apps/extension/src/ui/settings/` (checked 2026-10-06). Behaviour verified by the automated Chromium checks `npm run smoke:settings` and `npm run smoke:connect`, not yet on real user machines.
