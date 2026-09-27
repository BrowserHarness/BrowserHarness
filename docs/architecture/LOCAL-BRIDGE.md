# BrowserCrew Local Bridge Protocol v0.1

## Purpose
BrowserCrew Local Bridge lets a user-authorized local agent drive the BrowserCrew extension through the same browser runtime, task-session ownership, semantic element refs, and safety policy used by the built-in agent.

The bridge is **not** a remote web API. The daemon binds only to loopback.

## Components

```
Local agent
   ↓ authenticated HTTP
BrowserCrew Bridge daemon
   ↓ paired WebSocket
BrowserCrew MV3 service worker
   ↓
BrowserCrew browser runtime
```

## Default endpoints
- HTTP: `http://127.0.0.1:10087`
- WebSocket: `ws://127.0.0.1:10087/ws`
- Status: `GET /status`
- Commands: `POST /command`

The daemon creates a local pairing token in `~/.browsercrew-bridge/config.json`. The extension stores the token only in Chrome extension-local storage.

## Command envelope

```json
{
  "session": "phone-research",
  "title": "Phone research",
  "action": "observe_page",
  "args": {}
}
```

Every command must reuse the same `session` for one task. That session is the BrowserCrew task-session ID:
- the user's starting tab is borrowed;
- BrowserCrew-created tabs are owned;
- owned tabs are grouped under the task;
- unrelated tabs remain outside the session.

## Result envelope

Success:

```json
{"ok":true,"data":{}}
```

Failure:

```json
{
  "ok": false,
  "error": {
    "code": "APPROVAL_REQUIRED",
    "message": "Activate Place order"
  }
}
```

## Safety
External agents do not bypass BrowserCrew safety.

Before bridge `click` or Enter submission, BrowserCrew re-observes the target page. If the semantic element is marked consequential, the command returns `APPROVAL_REQUIRED` rather than executing.

Borrowed tabs cannot be closed by session-owned cleanup.

## Semantic targets
Normal page observations expose stable semantic refs such as `@e12`. External agents should use those refs rather than CSS classes.

## Full-page reading
Use `read_page` only when the compact `observe_page` view is insufficient for research or extraction. It scans with hard character/screen/time budgets, restores the original scroll position, returns `next_start` for bounded continuation, and reports stall/endless-feed signals rather than pretending an infinite page is complete.

The default extraction window is intentionally smaller than many browser agents (12k chars) to reduce provider token/rate-limit pressure. A top-frame read can also return readable frame IDs/handles for separate frame reads.

## Full browser-control layer
The primary BrowserCrew build exposes its full browser-agent runtime through the authenticated Local Bridge, including accessibility-tree/CDP targeting, trusted mouse/text/key input, native dialog handling, network inspection, upload, PDF export, and raw CDP escape-hatch commands.

External agents use the same BrowserCrew task-session and result envelopes rather than maintaining a second browser-control implementation.

## Current tool surface
- observe_page
- read_page
- ax_snapshot
- navigate
- click
- trusted_click
- type
- trusted_type
- press_key
- trusted_key
- scroll
- wait
- open_tab
- find_tab
- list_tabs
- switch_tab
- close_tab
- screenshot
- dialog
- network
- upload
- save_pdf
- cdp

The v0.1 command envelope remains stable while the tool surface expands.
