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
- Stronger framework-controlled input fills using native value setters
- Stronger contenteditable/rich-editor insertion path

### Next
- BrowserCrew Local Bridge protocol for external agents
- Companion/advanced CDP distribution for trusted-input escape-hatch cases
- External-agent session API compatible with BrowserCrew task ownership
- Workflow variables and branches
- Reusable Skill runtime
- Record → Skill, Session → Skill, Site → Skill
- More provider adapters/local runtimes
- Stronger recovery/evaluations

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
