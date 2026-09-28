# Browser Control Protocol — v0.2

## Principles
- Tools expose semantic browser intent before raw CDP.
- Page content is untrusted data.
- Browser tasks own explicit task sessions; the user's starting tab is borrowed and BrowserCrew-created tabs are owned.
- Observation/AX evidence is refreshed before adaptive execution; stale recorded refs are evidence hints, not live selectors.
- Mutating or context-changing actions are followed by verification.
- Consequential actions keep BrowserCrew approval semantics.
- Functionality and reliability take priority over minimizing the browser permission envelope.

## Core observation
`observe_page` returns compact URL/title/text and interactive DOM semantics.

`read_page` performs bounded document extraction with continuation, frame metadata, scroll restoration and stall/endless-feed signals.

`ax_snapshot` uses `Accessibility.getFullAXTree` and emits temporary `@eN` semantic refs backed by backend DOM node IDs.

`find` captures a fresh AX tree and searches it by semantic text and/or role. It never asks the model to invent refs.

## Tool surface
The primary runtime and authenticated Local Bridge expose 27 tools:

- Observation/inspection: `observe_page`, `read_page`, `ax_snapshot`, `find`, `evaluate`, `screenshot`
- Learning: `site_skill` (`create`, `verify`, `run`, `list`, `get`, `delete` candidate Skills)
- Native form control: `select_option`
- DOM/browser actions: `navigate`, `click`, `type`, `press_key`, `scroll`, `wait`
- Trusted CDP input: `trusted_click`, `trusted_type`, `trusted_key`
- Tabs/sessions: `open_tab`, `find_tab`, `list_tabs`, `switch_tab`, `close_tab`
- Browser/platform: `dialog`, `network`, `upload`, `save_pdf`, `cdp`

## High-value contracts

### site_skill
`create` inspects the selected http(s) task tab with fresh AX evidence and bounded form structure evaluation. If network capture is already active, bounded request evidence is summarized without retaining header/body secret values. BrowserCrew compiles and persists an inspectable candidate Skill with inferred parameters, fresh-resolution targets, recipe verification checks and runtime approval policy.

`verify` recollects live origin/form/field/submit evidence and persists an explicit verified/failed result.

`run` re-verifies immediately before execution, resolves every recipe target from a fresh AX snapshot, rejects ambiguous matches, binds user parameters, and executes text/select/upload/toggle + submit steps. Non-GET or risky submission returns `APPROVAL_REQUIRED`; only the BrowserCrew extension UI can provide the one-shot approval proof. Run parameter values are redacted from session evidence.

`list`, `get` and `delete` manage the local candidate library. Site Skills remain candidate status; verified execution does not auto-promote them.

### select_option
Input: fresh AX `element_id` plus `value` or `values`.

Resolves the native select through CDP, matches by option value/text/label, updates selection and dispatches bubbling `input` + `change` events. Empty or unmatched requests fail rather than silently selecting the wrong option.

### hover
Input: fresh AX `element_id`, optional `tab_id`.

Moves the real CDP pointer to the target box center. BrowserCrew rejects an occluded point and verifies the intended target enters `:hover` before reporting success.

### drag
Input: fresh `source_element_id` and `target_element_id`, optional `steps` and `tab_id`.

BrowserCrew hit-tests both semantic endpoints, presses the real left mouse button, follows a bounded interpolated CDP pointer path, releases over the target, and verifies source-down/target-up delivery before reporting success.

### send_keys
Input: `keys`, optional `repeat` (1-100) and `tab_id`.

Supports Alt/Ctrl/Cmd/Meta/Shift, OS-aware `Mod` (Cmd on macOS, Ctrl elsewhere), Enter/Escape/Tab/Backspace/Delete/Space, arrows, Home/End/PageUp/PageDown, F1-F12, single letters/digits, modifier chords such as `Mod+A`, and space-separated sequences such as `Enter Escape`. Sequences containing Enter preserve BrowserCrew approval rules.

### await_user_action
Planner/orchestrator-only; intentionally not exposed as a Local Bridge daemon command.

Input: `reason`.

Use when progress requires a human-only page step such as login/sign-in, an expired authenticated session, CAPTCHA/slider/human verification, 2FA/SMS/authenticator approval, or explicit manual consent. BrowserCrew waits up to 10 seconds for natural navigation first. If the page has not advanced, the side panel shows “Need you to take over” with “I’m done, continue” and “Cancel task”. Navigation remains a live resume path while the card is visible. Continuation always triggers a fresh page observation before planning resumes.

Manual handoffs are recorded as non-executable session evidence. They do not advance `boundary_action_id`, and Session → Skill compilation rejects sessions crossing a manual-handoff precondition instead of pretending the human-only step is automated.

### trusted_click
Input: fresh AX `element_id`, optional `tab_id`.

BrowserCrew scrolls the target into view, calculates its box center, verifies `document.elementFromPoint` resolves to the target or one of its descendants, arms temporary pointer/mouse delivery proof listeners, dispatches real CDP mouse events, then refuses success unless delivery to the intended target was observed.

### evaluate
Input: `expression`, optional `max_chars` and `tab_id`.

Runs bounded `Runtime.evaluate` with `awaitPromise`, `returnByValue` and `userGesture`. Exceptions are surfaced and oversized results are rejected instead of flooding model context. Raw `cdp` remains the escape hatch.

### screenshot
Input: optional `tab_id`, `full_page`, `element_id`.

Uses `Page.captureScreenshot`, so BrowserCrew can capture its selected task tab while it remains backgrounded. Modes:
- viewport
- full page via `Page.getLayoutMetrics`
- semantic element clip via fresh AX ref + `DOM.getBoxModel`

### network
Actions: `start`, `list`, `detail`, `stop`.

Capture includes request/response lifecycle metadata, response bodies, `Network.requestWillBeSentExtraInfo` wire headers, and `Network.getRequestPostData` recovery when Chrome omits the POST body from the initial event.

### upload
Uses `DOM.setFileInputFiles` against a fresh semantic target.

### save_pdf
Uses `Page.printToPDF` and Chrome downloads.

### dialog
Tracks native alert/confirm/prompt state from CDP and resolves it with `Page.handleJavaScriptDialog`.

## Adaptive replay approval proof
The extension UI may send a one-shot `approval_granted` proof after explicit user approval. The service worker accepts it only from a same-extension page with no sender tab. Content scripts, normal web tabs, other extensions and Local Bridge commands cannot mint privileged approval.

A newly risky AX-only trusted action therefore follows:
1. attempt without privileged proof;
2. service worker returns `APPROVAL_REQUIRED`;
3. BrowserCrew UI asks the user;
4. approval retries once with privileged proof;
5. denial stops replay.

## Failure contract
Tools return typed failures such as:
- `TAB_NOT_FOUND`
- `CONTENT_SCRIPT_UNAVAILABLE`
- `ELEMENT_NOT_FOUND`
- `ELEMENT_NOT_ACTIONABLE`
- `APPROVAL_REQUIRED`
- `NAVIGATION_FAILED`
- `FIND_FAILED`
- `EVALUATE_FAILED`
- `SCREENSHOT_FAILED`
- `PERMISSION_DENIED`
- `TIMEOUT`
- `UNSUPPORTED_PAGE`
- `INTERNAL_ERROR`

The agent may re-observe and retry boundedly. It must not loop indefinitely.

## Consequential action boundary
Send/publish/submit/purchase/delete/payment/account-security actions remain approval-gated when BrowserCrew's current evidence marks them consequential. Generated/replayed Skills preserve those approval semantics and may not execute beyond their demonstrated boundary.
