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

It is a reference architecture audit, not copied implementation. BrowserCrew keeps its own provider-neutral model layer, safety approvals, least-privilege Core package, deterministic tests, and Skill evaluation policy.

### Next
1. **Watch Me v2 cross-page / multi-tab recording**
   - background-owned recording session
   - incremental step collection across navigations
   - tab creation/navigation/activation evidence
   - re-arm recording after page navigation
   - bounded evidence/storage budget
   - preserve the last recorded step as the workflow boundary
2. **Skill compiler**
   - Record → Skill
   - Session → Skill
   - reusable input/variable inference
   - candidate evaluation before promotion
3. Cross-runtime evaluation of `SK-BROWSER-001`
4. Companion/Advanced CDP distribution for trusted mouse/key/text, focus emulation, and native dialog handling
5. Network/upload/PDF only after permission and safety contracts are explicit
6. Site → Skill after observation/recording/evaluation contracts stabilize

### Permission rule
The core extension remains least-privilege. Chrome does not allow the `debugger` permission to be optional, so raw CDP will not be added to the core package merely as an optional feature. Trusted-CDP control belongs in a separately disclosed Advanced/Bridge distribution.

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
