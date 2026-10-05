# BrowserHarness browser-agent architecture (Kimi-style, 2026-10-05)

**Goal:** an AI agent controls the user's real Chrome (their logins and tabs) and completes the task it was given. This document compares Kimi's shipped design with BrowserHarness today and sets the target architecture and build order.

Clean-room note: this uses Kimi's public documentation and our earlier behaviour audit (`docs/research/KIMI-EXTENSION-REFERENCE-AUDIT.md`). No Kimi code is copied.

## 1. How Kimi does it

Kimi's browser extension, formerly "Kimi WebBridge", has **two ways to drive the browser**:

1. **Side-panel chat.** The user signs in and chats in the browser sidebar. Kimi's own hosted model plans every step; Moonshot says this is Kimi K2.6.
2. **Remote control by a local agent.** Claude Code, Codex, Cursor, Kimi Code, Hermes or OpenClaw drive the extension through a **local bridge service**:
   - **Install:** one terminal command (`curl … | bash`) installs the bridge, and `kimi-webbridge status` checks it.
   - **Agent setup:** the installer also **writes skill files into each agent it finds**. The user then types `/kimi-webbridge` in that agent.

Under both modes:
- **Extension = hands:** it executes through the **Chrome DevTools Protocol**, in the user's own Chrome with their cookies and logins. Page content and logins stay on the machine.
- **Observation:** accessibility-tree snapshots with `@eN` refs, plus screenshots, page text and table extraction. Actions are clicks, form fills, keys, navigation, uploads and PDF.
- **Reuse:** websites can be "turned into CLI commands", and recorded actions can become Skills that agents reuse.
- **Known limits:** Chrome/Edge only; shadow DOM, React and lazy loading can fail; risky actions need confirmation.

Sources: Kimi help ("How Kimi WebBridge works", "Introduction"), Analytics Vidhya hands-on guide (May 2026), Decrypt (May 2026).

## 2. BrowserHarness today vs Kimi

| Kimi piece | BrowserHarness today | Gap |
|---|---|---|
| Side-panel chat with one strong hosted model | Side-panel agent with **any** model the user connects (OpenRouter, keys, LM Studio, Ollama, subscriptions) | Weak or tiny models fail at browser control. The plan is JSON-in-text, not native tool calling |
| Local bridge service | Local Bridge daemon (loopback, pairing token, WebSocket to the extension) | No installer. It runs from the repo (`node apps/bridge/src/cli.mjs start`), and the user must copy-paste a token |
| Agent integration via skill files + `/kimi-webbridge` | MCP server (`browserharness-bridge mcp`) exposing `browserharness_*` tools | Nothing registers it in Claude Code, Codex, Cursor or Hermes, and there is no skill file teaching the agent how to drive well. Tool inputs are a generic `args` object, not typed |
| CDP accessibility-tree refs as the main page view | DOM-derived `@eN` refs for the main view; the AX tree only through `ax_snapshot` | Two ref systems can collide, shadow DOM and iframes are invisible to the main view, and the 250-element budget is wasted |
| Trusted CDP input | Built (trusted click, type, keys, focus emulation, dialogs) | Now used for Enter and Google Docs; elsewhere still only a fallback |
| Tab group per task | Built (borrowed vs owned tabs, grouping) | none |
| Website → CLI, recording → Skill | Site Skills with API recipes, Watch Me → Skill, verify/promote | Not exposed to external agents as simple commands |
| — | Task DAG + verifier workers, per-site approval grants, memory, Skill evaluation/promotion, provider-neutral routing | **Where BrowserHarness is ahead** |

## 3. Target architecture

```
                 ┌───────────────────────── BRAINS (planners) ─────────────────────────┐
                 │                                                                      │
  A. Side-panel agent (built in)                 B. External agents (remote control)
     any connected model, native tool calls         Claude Code · Codex · Cursor · Hermes · Kimi Code
     "browser-ready" models recommended             skill file + MCP (or CLI) installed by one command
                 │                                                     │
                 │ chrome.runtime messages                             │ MCP stdio / CLI → HTTP (loopback, token)
                 ▼                                                     ▼
        ┌─────────────────────────────────────────────────────────────────────────┐
        │  BrowserHarness Bridge daemon (login service on the user's computer)       │
        │  pairing · session routing · subscription adapters · MCP client/server     │
        └───────────────────────────────▲─────────────────────────────────────────┘
                                        │ paired WebSocket (ws://127.0.0.1:10087)
        ┌───────────────────────────────┴─────────────────────────────────────────┐
        │  Extension service worker = THE browser runtime (one tool contract)        │
        │  task sessions + tab groups · approvals + per-site grants · audit evidence │
        │                                                                            │
        │  Observe:  AX-tree snapshot (CDP, pierces shadow DOM + iframes), viewport  │
        │            first, interactive only, one @eN ref system; DOM view fallback  │
        │  Act:      DOM action → trusted CDP input → raw CDP (escape hatch)         │
        │            every action returns the new snapshot (no extra observe turn)   │
        │  Read:     read_page (scroll scan, frames, PDF) · screenshot · network     │
        │  Reuse:    Site Skills (API recipes, recorded flows) callable as commands  │
        └───────────────────────────────▲─────────────────────────────────────────┘
                                        │ content scripts (all frames) + CDP
                                   the user's real Chrome tabs
```

Principles:
1. **One browser runtime, many brains.** The side panel and every external agent call the same tools, sessions, approvals and evidence. A fix in the runtime helps every brain.
2. **The extension is the hands; planning lives in the brain.** Nothing in the browser runtime depends on which model plans.
3. **One observation contract.** Refs come from Chrome's accessibility tree when the debugger is available. Every action result carries the fresh snapshot.
4. **Safety stays in the runtime, not the prompt.** Approvals, borrowed-tab protection and per-site grants apply to every brain. MCP and CLI cannot bypass them.
5. **Local by default.** Pages, logins and Bridge traffic stay on the machine. Remote mode remains opt-in for later.

## 4. Build order

Each step ships on its own, with real-Chromium checks.

1. **One-command agent connect (Kimi's mode B).**
   - **Install:** `npx browserharness-bridge install` (and a `curl | bash` wrapper). It installs the Bridge as a login service (macOS launchd, Windows Task Scheduler, Linux systemd user unit).
   - **Pairing:** the user approves a pairing code shown in the side panel; no token copy-paste.
   - **Agent registration:** the installer detects Claude Code, Codex, Cursor and Hermes. It registers the MCP server in each, and writes a BrowserHarness skill file explaining how to drive the browser (observe → act → verify, sessions, approvals).
   - **Typed MCP tools:** per-tool input schemas (`click {element_id}`, `type {element_id,text}` …) instead of a generic `args` object.
   - **Acceptance:** on a clean machine, one command, then Claude Code completes a task in the user's Chrome.
   - **Status (built):** `install` / `uninstall` / `pair` / `agents` commands, code pairing, typed tools, Settings → Coding agents. Real-Chromium check `npm run smoke:bridge` (18 checks) installs into a temporary home with the four agents, pairs by code, and an MCP client completes a task. The real `claude mcp list` reports the server connected. Not yet run on a real Mac or Windows machine, or with a real agent model driving the task.
2. **AX-first observation.**
   - **Main view:** `observe_page` uses the CDP accessibility tree (interactive nodes, viewport first, shadow DOM and same-origin iframes included), with one `@eN` ref namespace and a snapshot generation id.
   - **Fallback:** the DOM view only when the debugger cannot attach.
   - **Acceptance:** shadow-DOM and iframe stand-in pages pass, and stale refs fail loudly instead of hitting the wrong element.
   - **Status (built, different route):** the page view still comes from the content script, which now walks open and closed shadow roots and same-origin iframes, lists on-screen elements first and flags the rest `offscreen`. It does not attach the debugger, so there is no "started debugging" bar just to look at a page. `ax_snapshot`/`find` now reuse and stamp the same `data-browserharness-ref` attribute, so one `@eN` names one element for every tool; CDP tools resolve any ref through the page attribute and refuse a ref whose element is gone. Trusted clicks hit-test inside iframes and shadow roots. `trusted_click` checks the accessible name for approval on any ref. Check: `npm run smoke:deep` (16). Still out of reach: cross-origin iframes (they need per-frame injection or CDP frame targets).
3. **Actions return the new snapshot.**
   - **What changes:** click, type, key and navigate return the changed page state, so the planner needs no separate observe turn.
   - **Acceptance:** about half the model calls per task in smoke runs.
4. **Native tool calling in the side-panel agent.**
   - **What changes:** the OpenAI-style `tools` and Anthropic `tool_use` APIs replace JSON-in-text. The LM Studio JSON schema remains the fallback.
   - **Model guidance:** the model menu shows a "browser-ready" badge from the agent check, and recommends models for page control.
5. **Website → command for agents.**
   - **What changes:** proven Site Skills and API recipes show up as named tools/commands (for example `browserharness site run amazon-search --q "kettle"`), the equivalent of Kimi's "turn a website into a CLI".
6. **Then the PRD release matrix** (W1–W5 × 25 scenarios × 3 runs) on real sites with real models.

## 5. What we keep that Kimi does not have
- Any model, including the user's own subscription or local models, not one vendor's model.
- A Task DAG with verifier workers, so research claims are re-checked.
- Approval cards with per-site grants and a recorded audit trail.
- Skills that are evaluated before promotion and can be rolled back.
- Memory of past tasks and procedures.
