# BrowserHarness Local Bridge Protocol v0.1

## Purpose
BrowserHarness Local Bridge lets a user-authorized local agent drive the BrowserHarness extension through the same browser runtime, task-session ownership, semantic element refs, and safety policy used by the built-in agent.

By default the bridge is **not** a remote web API: the daemon binds only to loopback. A remote mode exists for later, when BrowserHarness has its own infrastructure (see "Remote mode" below). It is off unless explicitly enabled.

## Components

```
Local agent
   ↓ authenticated HTTP
BrowserHarness Bridge daemon
   ↓ paired WebSocket
BrowserHarness MV3 service worker
   ↓
BrowserHarness browser runtime
```

## Default endpoints
- HTTP: `http://127.0.0.1:10087`
- WebSocket: `ws://127.0.0.1:10087/ws`
- Status: `GET /status`
- Commands: `POST /command`

The daemon creates a local pairing token in `~/.browserharness-bridge/config.json`. The extension stores the token only in Chrome extension-local storage.

## Page after an action
A successful page-changing command (click, type, press_key, navigate, open_tab, scroll, trusted_* …) answers `{ok, data, page}` where `page` is a fresh `observe_page` result, so agents need no separate observe call. Send `"observe": false` in `args` to skip it. The MCP server renders pages as compact text: one `@eN role "name" <tag> [flags]` line per element plus visible text.

## Pairing by code (no token copy)
1. The person presses **Pair** in BrowserHarness (Settings → Helper app). The extension calls `POST /pair/request`; the Bridge accepts it only with an `Origin: chrome-extension://<32-letter id>` header and returns a six-digit code, valid for 5 minutes.
2. The person types that code into the terminal (`browserharness-bridge pair`, or the installer's last step). The CLI calls `POST /pair/approve {code}` with the Bearer token, which only someone who can read the config file has. Extension-origin requests cannot approve. Five wrong codes clear all pending requests.
3. The extension polls `POST /pair/status {request_id}` and receives the token once, only for the extension id that asked.

Every HTTP and WebSocket request with a web (`http(s)://`) Origin is refused with 403, so web pages, including DNS-rebinding pages, cannot reach the Bridge. Local programs (no Origin) and the extension are allowed.

## Install for coding agents
`browserharness-bridge install` (or `install.sh` / `install.cmd` next to the single-file build `browserharness-bridge.mjs`):
- copies the single-file build to `~/.browserharness-bridge/bin/` (a source checkout is used where it is);
- starts the Bridge at login: systemd user unit (Linux), LaunchAgent `com.browserharness.bridge` (macOS), Startup-folder script (Windows). Without a systemd user session it starts the Bridge now only;
- registers the `browserharness` MCP server in Claude Code (`claude mcp add --scope user`, else `~/.claude.json`), Codex (`~/.codex/config.toml`), Cursor (`~/.cursor/mcp.json`) and Hermes (`~/.hermes/config.yaml`), and writes a `browserharness` skill (`~/.claude/skills`, `~/.agents/skills`, `~/.hermes/skills`; Cursor reads the first two). Each config file is backed up once as `<file>.before-browserharness`; broken or hand-written entries are left alone;
- asks for the pairing code when run in a terminal.

`browserharness-bridge uninstall` removes the service, the agent entries, the skill files and the launcher; `--purge` also deletes the config and token. `browserharness-bridge agents` lists which agents were found.

## Command envelope

```json
{
  "session": "phone-research",
  "title": "Phone research",
  "action": "observe_page",
  "args": {}
}
```

Every command must reuse the same `session` for one task. That session is the BrowserHarness task-session ID:
- the user's starting tab is borrowed;
- BrowserHarness-created tabs are owned;
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
External agents do not bypass BrowserHarness safety.

Before bridge `click` or Enter submission, BrowserHarness re-observes the target page. If the semantic element is marked consequential, the command returns `APPROVAL_REQUIRED` rather than executing.

Borrowed tabs cannot be closed by session-owned cleanup.

## Semantic targets
Normal page observations expose stable semantic refs such as `@e12`. External agents should use those refs rather than CSS classes.

## Full-page reading
Use `read_page` only when the compact `observe_page` view is insufficient for research or extraction. It scans with hard character/screen/time budgets, restores the original scroll position, returns `next_start` for bounded continuation, and reports stall/endless-feed signals rather than pretending an infinite page is complete.

The default extraction window is intentionally smaller than many browser agents (12k chars) to reduce provider token/rate-limit pressure. A top-frame read can also return readable frame IDs/handles for separate frame reads.

## Full browser-control layer
The primary BrowserHarness build exposes its full browser-agent runtime through the authenticated Local Bridge, including accessibility-tree/CDP targeting, trusted mouse/text/key input, native dialog handling, network inspection, upload, PDF export, and raw CDP escape-hatch commands.

External agents use the same BrowserHarness task-session and result envelopes rather than maintaining a second browser-control implementation.

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


## MCP stdio server

BrowserHarness Bridge can expose the same browser runtime to MCP hosts:

```text
MCP host
   ↓ stdio MCP
browserharness-bridge mcp
   ↓ authenticated loopback POST /command
BrowserHarness Bridge daemon
   ↓ paired WebSocket
BrowserHarness MV3 service worker
   ↓
BrowserHarness browser runtime
```

Run:

```bash
browserharness-bridge mcp
```

The MCP server uses the current v2 `@modelcontextprotocol/server` stdio path and exposes `browserharness_status` plus one `browserharness_<action>` tool for every Local Bridge browser action.

Every browser-action tool requires a stable `session` value. Reuse the same value across calls for one task so the normal BrowserHarness task-session ownership rules remain in force.

MCP does not bypass BrowserHarness approvals. A Bridge result such as `APPROVAL_REQUIRED` is returned as an MCP tool error result. Borrowed user tabs remain protected by the extension's existing ownership policy.

The MCP process only accepts loopback BrowserHarness Bridge configuration. Stdout is reserved for MCP JSON-RPC; diagnostics are written to stderr.

## Remote mode (opt-in, off by default)

Reserved for connecting the extension to BrowserHarness-operated servers (for example to improve the product over time). Nothing dials out unless the user turns it on.

Bridge side:
- `browserharness-bridge remote on [bind-host]` sets `allow_remote: true` and a non-loopback bind host (default `0.0.0.0`). `remote off` returns to `127.0.0.1`. `remote` prints the current mode. Restart the daemon to apply.
- The daemon refuses a non-loopback host unless `allow_remote` is exactly `true`, and refuses a pairing token shorter than 32 characters in remote mode. Tokens are compared in constant time.
- `/status` reports `remote_mode`. Local CLI and MCP always reach the daemon through loopback (a wildcard bind maps to 127.0.0.1).
- The daemon speaks plain `ws://`. Run it behind a TLS-terminating reverse proxy and publish only the `wss://` address.

Extension side:
- `ws://` stays loopback-only. A non-loopback Bridge must be `wss://host/ws`, and saving it requires a pairing token of at least 32 characters.
- Chrome host access for the Bridge origin is requested at save time as for the local Bridge.

Approvals, task-session ownership and autonomy ceilings apply identically over a remote Bridge. Anyone holding the pairing token can drive the paired browser, so treat it like a credential: rotate it by replacing `token` in `~/.browserharness-bridge/config.json` with a new random value of 32+ characters, restarting the daemon, and pairing the extension again.

## API Anything compatibility adapter (read-only)

The Bridge ships [API Anything](https://github.com/goodnight000/api-anything) at commit `fe5cca7` (MIT, vendored in `apps/bridge/vendor/api-anything`, see `docs/architecture/API-ENGINE-ADR.md`) as a built-in MCP server. It is off until a person turns it on:

```bash
browserharness-bridge api-anything enable     # adds {"api-anything": {"builtin": "api-anything"}} to mcp-servers.json
browserharness-bridge restart
browserharness-bridge api-anything status     # tools, availability and diagnostics
```

- It runs as `browserharness-bridge api-anything-mcp` under the Bridge's own Node, with its data in `~/.browserharness-bridge/api-anything` (never the person's own `~/.api-anything`).
- Four tools: `list_sites`, `list_operations`, `call_operation` (all `readOnlyHint`) and `login` (not read-only, so BrowserHarness asks first under every trust mode).
- Reads only. Write operations are hidden and refused; a write goes through a BrowserHarness Site Skill, which asks the person to approve it.
- Plain HTTP (tier 1) only. Upstream's own Chrome tiers, capture and login window are disabled in the vendored copy, because BrowserHarness has one browser runtime.
- `login` only re-imports from the browser profile a person chose at a terminal: `browserharness-bridge api-anything login <site> [--profile "Chrome/Profile 1"]` (Node 22.13 or newer, for `node:sqlite`). It never picks a profile and never opens a browser. Agents see cookie names, never values.
- The extension reaches it through the existing outbound MCP path (`mcp_request`), its trust modes, approval retry and task-ranked catalog. Nothing in the planner treats it specially.

Diagnostics: `GET /status` has `mcp_server_health` per server (`state`: idle, starting, connected, exited, failed, unavailable; `starts`, `startup_failures`, `exits`, `calls`, `call_errors`, `last_error`, `last_call_error`). A server whose process exits is restarted on its next use. Settings → Helper app → tools shows the same state in plain words.

This adapter is a stepping stone. BrowserHarness's own learning and execution of website operations is the Native API Engine (`docs/protocols/API-RECIPE-V2.md`).
