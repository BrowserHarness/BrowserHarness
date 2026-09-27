# BrowserCrew Roadmap

## Foundation
- Organization operating layer
- Browser/control protocol
- Provider-neutral model contracts
- Permission/autonomy model
- Progress-Memory and evaluation baseline

## v0.1 — Ship-fast MVP
**Status:** automated feature-complete; final real-Chrome acceptance pending.

Goal: install BrowserCrew, connect an AI provider, give the current tab a task, and reliably observe/act/verify with visible activity and approval gates.

### Required
- Chrome Manifest V3 side panel
- Chat-first UI with progressive disclosure
- Current-tab attachment and context
- Single agent execution loop
- DOM/accessibility observation + screenshot fallback
- Core tools: observe_page, navigate, click, type, press_key, scroll, wait, open_tab, switch_tab, close_tab, screenshot
- OpenAI, Anthropic, NVIDIA and OpenAI-compatible provider connections
- Automatic model discovery for providers exposing compatible `/models` endpoints, with manual fallback
- Single-agent multi-tab operation
- Inline activity, pause/stop and consequential-action approvals
- Local task history
- Basic Watch Me → save workflow → replay
- Material Design UI; Poppins headings, Inter body/UI
- Release evaluation scenarios and Chrome Web Store packaging baseline

### Explicit non-goals
- Multi-agent teams / supervisor workers
- Deep semantic/episodic memory
- Automatic Skill creation/promotion
- MCP ecosystem
- Scheduled/background agents
- Marketplace/community Skills
- Team/enterprise administration
- BrowserCrew-hosted inference

## v0.1.1 — Reliable Model + Agent Runtime
**Status:** integrated into the v0.1 MVP candidate; automated gate green.

Goal: make provider/model behavior predictable before expanding product scope.

### Required
- Multiple saved provider/model connections
- Capability classification: chat, agent, vision, embedding, reranker, audio, image, unknown
- Separate Chat and Agent health probes
- Explicit Primary + one Fallback model
- Failover only on recoverable provider/model failures
- Direct chat isolated from browser-agent planning
- Compact page observations (bounded visible text + interactive elements)
- Duplicate-action loop detection and bounded execution
- Explicit site-adapter boundary with Google Docs adapter
- Internal-first stability gate with regression tests before user acceptance

### Deferred from v0.1.1
- Multi-agent teams
- Full vision execution path
- Embedding-backed memory
- Audio/image-generation model execution
- Automatic model benchmarking/ranking
- More than one fallback hop

## v0.2 — Browser Reliability + Bridge Foundation
**Status:** active after the user explicitly reopened post-MVP development before manual acceptance.

### Verified reliability work
- One browser task = one task session
- User starting tab is borrowed, not owned
- BrowserCrew-created tabs are task-owned and grouped
- Session cleanup can only close owned tabs
- Session-scoped `list_tabs` and `find_tab`
- Stable semantic `@e` element references
- Compact accessibility-style page snapshots
- Serialized task-session mutations prevent concurrent tab-state loss
- Navigation waits for a usable document and captures final redirected URL
- Dedicated bounded `read_page` with scroll restoration, continuation, frame metadata, stall/endless-feed signals, and token-efficient defaults
- Stronger framework-controlled input fills using native value setters
- Stronger contenteditable/rich-editor insertion path
- Watch Me v2: richer target metadata, input debouncing, key steps, inferred workflow inputs, resilient locator matching, reinjection-safe content runtime
- Watch Me v2 cross-page/multi-tab recording:
  - background-owned recording session survives document/side-panel lifecycles
  - content scripts stream steps instead of owning recorder state
  - top-frame navigation evidence via webNavigation
  - automatic recorder re-arm after navigation/reload
  - opener-tab adoption plus user-selected tab adoption across windows
  - tab-open/tab-activate/tab-close context evidence
  - serialized recording writes
  - hard budgets: 1,000 steps, 2,000 context events, 50 tabs, ~2 MB evidence
  - dropped excess evidence never moves the final actionable workflow boundary
  - v3 workflows store events, recording summary and boundary_step_id
  - WATCH_STATUS restores active recording UI after side-panel reload
- Task tabs stay backgrounded by default; `find_tab` does not steal foreground focus
- Screenshot refuses to capture a different foreground tab when the task target is backgrounded

### Verified Local Bridge foundation
- Loopback-only BrowserCrew Bridge daemon workspace
- Pairing-token authentication
- `GET /status` and authenticated `POST /command`
- MV3 WebSocket client with protocol/version handshake
- 20-second heartbeat + reconnect path
- Bridge session IDs map directly to BrowserCrew task sessions
- External bridge commands use the same semantic refs and browser tools
- Risky bridge click/Enter actions return `APPROVAL_REQUIRED`
- Settings UI for address/token/connection state
- CLI operations: `start`, `status`, `stop`, `restart`, `logs`, `pair`
- Machine-readable and human-readable Bridge protocol v0.1

### Source-audit reference
A behavioral clean-room audit of the shipped Kimi Browser Extension 2.0.22 is recorded at:
`docs/research/KIMI-EXTENSION-REFERENCE-AUDIT.md`

It is a reference architecture audit, not copied implementation. BrowserCrew keeps its own provider-neutral model layer, safety approvals, full browser-control runtime, deterministic tests, Local Bridge, and Skill evaluation policy.

### Next
1. **Skill compiler**
   - Record → Skill from verified Watch Me v3 evidence
   - Session → Skill from BrowserCrew task-session evidence
   - reusable variable/input inference
   - browser-context plan extraction from navigation/tab events
   - preserve boundary_step_id as the maximum demonstrated workflow boundary
   - emit candidate Skill + evaluation matrix, never auto-promote without evidence
2. **Adaptive workflow replay**
   - replay recorded intent/context rather than brittle exact-tab IDs
   - remap recorded tabs to current task-session tabs
   - recover stale refs through observe/AX escalation
3. Cross-runtime evaluation of `SK-BROWSER-001` v0.3.0
4. Trusted-click hardening
   - occlusion/hit-test verification
   - explicit CDP input-delivery verification
5. Site → Skill after Record/Session → Skill contracts stabilize

### Verified full browser-control parity
- debugger/CDP attach manager
- Accessibility.getFullAXTree + backend-node semantic refs
- trusted mouse/key/text input
- focus emulation
- native dialog state/accept/dismiss
- raw CDP escape hatch
- network start/list/detail/stop + response-body retrieval
- file upload through DOM.setFileInputFiles
- Page.printToPDF + Chrome downloads

### Browser capability rule
BrowserCrew is an autonomous browser agent. Functionality and reliability take priority over minimizing the permission envelope.

The primary BrowserCrew build now intentionally targets the proven high-capability browser-agent surface:
- debugger / Chrome DevTools Protocol
- <all_urls>
- webNavigation
- webRequest
- unlimitedStorage
- windows / tabs / tabGroups
- scripting
- alarms / notifications / context menus

The permissions must map to real BrowserCrew capabilities and remain covered by automated tests, but they are no longer deferred into a separate reduced-capability edition.

## v0.3 — Memory + MCP
- Working/episodic/semantic/procedural memory
- Skill reuse/retrieval
- MCP client/tool bridge

## v0.4 — Multi-agent / multi-tab
- Supervisor/workers
- Task DAG
- Tab ownership/locks
- Verifier agents and shared workspace

## v0.5 — Self-improvement
- Recovery learning
- Candidate Skill versions
- Automated evaluation/promotion gates
- Rollback

## v0.6+ — Commercial platform expansion
- Scheduling/background execution
- Team/shared Skills
- Marketplace/distribution
- Admin/audit/policy controls
- Enterprise deployment options
