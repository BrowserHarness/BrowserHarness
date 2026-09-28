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
The primary runtime and authenticated Local Bridge expose 25 tools:

- Observation/inspection: `observe_page`, `read_page`, `ax_snapshot`, `find`, `evaluate`, `screenshot`
- DOM/browser actions: `navigate`, `click`, `type`, `press_key`, `scroll`, `wait`
- Trusted CDP input: `trusted_click`, `trusted_type`, `trusted_key`
- Tabs/sessions: `open_tab`, `find_tab`, `list_tabs`, `switch_tab`, `close_tab`
- Browser/platform: `dialog`, `network`, `upload`, `save_pdf`, `cdp`

## High-value contracts

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
