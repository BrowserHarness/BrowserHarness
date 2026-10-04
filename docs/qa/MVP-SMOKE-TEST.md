# BrowserHarness v0.1 Final Real-Chrome Acceptance Gate

**Purpose:** perform the smallest necessary manual acceptance pass after the automated MVP gate is green.

## Automated prerequisite
Do not start manual acceptance unless the exact candidate has already passed:
- TypeScript;
- all unit/regression tests;
- production build;
- MV3 output validation;
- MVP automated contract gate;
- ZIP packaging and artifact upload.

Verified automated code baseline before final docs reconciliation:
- code SHA: `76218f69e16afae0f079d0cf4b4956754df39dfa`
- GitHub Actions run: `36262532519`
- tests: **63/63 across 14 files**
- result: **success**

## What automation already covers
The deterministic runtime suite covers:
1. current-page read;
2. navigation and post-action verification;
3. site search;
4. form fill without submit;
5. multi-tab retained evidence;
6. approval cancellation before consequential action;
7. pause and stop gates;
8. Watch Me workflow storage contract;
9. stale-element re-observation/recovery;
10. unsupported-page failure;
11. provider 429/timeout/fallback policy;
12. model capability discovery and Chat/Agent probes;
13. screenshot handoff to vision-capable models;
14. local-history privacy behavior;
15. optional website/custom-endpoint permission helpers;
16. MV3 permission posture and extension icons.

## Final manual acceptance only

### A. Install the packaged build
1. Extract the CI artifact and inner extension ZIP.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Load the unpacked folder containing `manifest.json`.
5. Open the BrowserHarness side panel.

Pass:
- side panel renders;
- no startup console errors;
- temporary MVP extension icon appears.

### B. Validate one live model
In **Models & connections**:
1. connect one provider;
2. select a model;
3. run **Test Chat + Agent & save**.

Pass:
- Chat health is healthy;
- Agent health is healthy for browser automation;
- no API key appears in visible activity/log output.

Optional: configure one second healthy model as Fallback and confirm the header shows **Auto**.

### C. Direct chat
Prompt:
`write a 30 second video script about AI and its future`

Pass:
- response is returned as ordinary chat;
- BrowserHarness does not read the current webpage.

### D. Normal browser task
Use a safe normal website task such as current-page summary, navigation, or site search.

Pass:
- observe → decide → act → verify is visible;
- result matches the page;
- no repeated-action loop.

### E. Browser access
Test with all-sites access off, then enable it in Settings.

Pass:
- current-tab invocation works where Chrome grants active-tab access;
- cross-site/multi-tab access asks for or uses the optional website permission;
- permission failure is reported as `PERMISSION_REQUIRED`, not as a generic reload error.

### F. Google Docs adapter
Open Google Docs, place the cursor, and request a short insertion.

Pass:
- BrowserHarness detects the Google Docs adapter;
- text is inserted at the active document editor target;
- activity finishes instead of hanging.

### G. Watch Me
Record a safe click/text workflow and replay it.

Pass:
- semantic steps save locally;
- password fields are not captured;
- replay completes;
- consequential replay actions still require approval.

### H. Consequential approval
Attempt a harmless test flow whose final control is classified as send/submit/purchase/delete/security-changing, without completing a real transaction.

Pass:
- BrowserHarness stops before the action;
- Cancel prevents it;
- Approve permits only that proposed action.

### I. Vision screenshot
Only if a validated vision-capable Agent model is available, use a visually sparse/canvas page that causes the agent to request `screenshot`.

Pass:
- screenshot is captured;
- image is sent only to the vision-capable model;
- next planning turn uses the visual evidence;
- non-vision models reject screenshot evidence cleanly.

## Public-release rule
If this focused real-Chrome acceptance passes, v0.1 can move from **automated-complete** to **release candidate accepted**. Failures should be recorded as concrete acceptance blockers; do not reopen post-MVP scope.
