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

## Core vs Advanced Bridge
The core BrowserCrew extension deliberately does not request Chrome's `debugger` permission. Chrome does not allow that permission to be optional.

Therefore raw CDP/trusted-input support will live in a separately disclosed BrowserCrew Advanced/Bridge distribution. The core Local Bridge protocol remains compatible with the least-privilege extension.

## Current tool surface
- observe_page
- read_page
- navigate
- click
- type
- press_key
- scroll
- wait
- open_tab
- find_tab
- list_tabs
- switch_tab
- close_tab
- screenshot

Future protocol versions may add Skills, workflows, network inspection, upload, PDF, and Advanced/CDP commands without changing v0.1 command envelopes.
