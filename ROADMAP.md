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
- Screenshot targets the selected task tab through CDP even when backgrounded, with viewport, full-page and semantic-element clip modes

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
1. **Skill compiler — verified**
   - Record → Skill verified at `9a21949333de565e5a77001ce1f39da95e346657`
   - Session → Skill verified at `595af74d2a947a8ef7cc41d29c0f119cc9798dfa`
   - generated Skills remain candidate-only; evaluation is required before promotion
2. **Watch Me v3 adaptive workflow replay — verified**
   - SavedWorkflow v3 compiles before replay, remaps logical tabs into a fresh task session, resolves fresh DOM/AX targets and stops at the demonstrated boundary
   - privileged trusted-input approval proof is now wired from the extension UI; newly risky AX-only targets can be approved and retried once without exposing the approval channel to Local Bridge callers
3. **Kimi-reference browser reliability hardening — verified at `3b6c7567f5f20124bedbe30abdac45005c777756`**
   - trusted clicks reject occluded targets using a fresh hit test
   - trusted clicks verify pointer/mouse delivery to the intended target before reporting success
   - screenshots use CDP for background viewport, full-page and semantic-element capture
   - `find` searches a fresh AX tree by semantic query/role
   - `evaluate` provides bounded JSON-safe page-context inspection
   - network evidence merges `Network.requestWillBeSentExtraInfo` headers and recovers omitted POST bodies with `Network.getRequestPostData`
   - Local Bridge/browser runtime surface is now 25 tools
   - CI run `36367934722`: 160/160 extension tests across 32 files + 3/3 Bridge tests, all build/validation/package gates green
4. **Site → Skill v1 — active engineering target**
   - use AX + `find` + bounded `evaluate` + high-fidelity network evidence to discover stable site workflows
   - emit inspectable candidate Skill recipes with parameters, provenance, verification evidence and explicit safety boundaries
   - never auto-promote generated Skills
5. **SK-BROWSER-001 v0.3.0 cross-runtime evaluation — parallel external-runtime blocker**
   - run the existing 25-case evaluation only when a real external agent runtime is paired to BrowserCrew Local Bridge
   - do not substitute product unit tests or fabricate cross-runtime results
6. Remaining Kimi-reference parity after Site → Skill
   - hover / drag / select-option
   - richer key chords/sequences
   - await-user-action / human handoff
   - user-facing Session → Skill runner and parameter editing
   - saved Skill library/run/version/delete/refine
   - subagents + context compaction

### Verified full browser-control parity
- debugger/CDP attach manager
- Accessibility.getFullAXTree + backend-node semantic refs
- trusted mouse/key/text input with click occlusion and delivery verification
- focus emulation
- native dialog state/accept/dismiss
- semantic AX find + bounded page evaluate
- background/full-page/element CDP screenshots
- raw CDP escape hatch
- network start/list/detail/stop + response-body retrieval + wire-header/post-data recovery
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
