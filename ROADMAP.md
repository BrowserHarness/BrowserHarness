# BrowserHarness Roadmap

## Foundation
- Organization operating layer
- Browser/control protocol
- Provider-neutral model contracts
- Permission/autonomy model
- Progress-Memory and evaluation baseline

## v0.1 — Ship-fast MVP
**Status:** automated feature-complete; final real-Chrome acceptance pending.

Goal: install BrowserHarness, connect an AI provider, give the current tab a task, and reliably observe/act/verify with visible activity and approval gates.

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
- BrowserHarness-hosted inference

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
- BrowserHarness-created tabs are task-owned and grouped
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
- Loopback-only BrowserHarness Bridge daemon workspace
- Pairing-token authentication
- `GET /status` and authenticated `POST /command`
- MV3 WebSocket client with protocol/version handshake
- 20-second heartbeat + reconnect path
- Bridge session IDs map directly to BrowserHarness task sessions
- External bridge commands use the same semantic refs and browser tools
- Risky bridge click/Enter actions return `APPROVAL_REQUIRED`
- Settings UI for address/token/connection state
- CLI operations: `start`, `status`, `stop`, `restart`, `logs`, `pair`
- Machine-readable and human-readable Bridge protocol v0.1

### Source-audit reference
A behavioral clean-room audit of the shipped Kimi Browser Extension 2.0.22 is recorded at:
`docs/research/KIMI-EXTENSION-REFERENCE-AUDIT.md`

It is a reference architecture audit, not copied implementation. BrowserHarness keeps its own provider-neutral model layer, safety approvals, full browser-control runtime, deterministic tests, Local Bridge, and Skill evaluation policy.

### Next
1. **Skill compiler — verified**
   - Record → Skill verified at `9a21949333de565e5a77001ce1f39da95e346657`
   - Session → Skill verified at `595af74d2a947a8ef7cc41d29c0f119cc9798dfa`
   - generated Skills remain candidate-only; evaluation is required before promotion
2. **Watch Me v3 adaptive workflow replay — verified**
   - SavedWorkflow v3 compiles before replay, remaps logical tabs into a fresh task session, resolves fresh DOM/AX targets and stops at the demonstrated boundary
   - privileged trusted-input approval proof is wired from the extension UI and cannot be minted by normal web/Bridge callers
3. **Kimi-reference browser reliability hardening — verified**
   - trusted-click occlusion + input-delivery proof
   - background/full-page/semantic-element CDP screenshots
   - semantic AX `find` + bounded page `evaluate`
   - high-fidelity network headers/POST-data recovery
4. **Site → Skill v1 — verified at `bbfed3443eea22df9b0115407519836263032469`**
   - `site_skill create`: fresh AX + bounded form inspection + optional active network evidence → persisted candidate Skill
   - deterministic parameter inference for text/select/upload/toggle fields
   - secret request/header values are not persisted in Site Skill evidence
   - `site_skill verify`: fresh origin/form/field/submit contract checks with explicit drift result
   - `site_skill run`: re-verifies immediately before execution, resolves fresh AX targets per step and rejects ambiguous matches
   - native `select_option` tool added; runner supports text/select/upload/toggle + submit
   - non-GET/risky submission returns `APPROVAL_REQUIRED` and retries only with extension-page approval proof
   - Site Skill run parameter values are redacted from BrowserTaskSessionEvidence
   - `list/get/delete` candidate library operations
   - candidate status is preserved after verified execution; no auto-promotion
   - Site Skill library now supports immutable history, compare/refine/promote/rollback and inspectable execution evidence
   - Local Bridge surface: **33 tools**; BrowserHarness runtime surface: **34 tools** including orchestrator-only human handoff
   - CI run `36369232137`: 181/181 extension tests across 38 files + 3/3 Bridge tests, all typecheck/build/MV3/contract/package gates green
5. **Kimi-reference interaction parity — verified**
   - hover — verified
   - drag/drop with real CDP pointer sequence + source/target delivery verification — verified at `7f3df6c3f1bbb2df440b63b0a41c2fbb70e0069c` (CI `36370487993`)
   - richer key chords/sequences/modifiers — verified at `f89e629ea4d5f14a82cc38021c9e7bbb5383ea24` (CI `36370758984`)
   - `send_keys` matches the Kimi reference surface: OS-aware `Mod`, Alt/Ctrl/Cmd/Meta/Shift, named navigation keys, F1-F12, sequences and repeat 1-100
   - `await_user_action` / human handoff — verified at `0204ecbf78b5be694267cf7a9dc0ea04afaeb9f4` (CI `36371442796`)
   - handoff waits 10 seconds for natural navigation before showing takeover UI; navigation remains a live resume path while the card is visible
   - takeover UI exposes “I’m done, continue” and “Cancel task”; continuation always re-observes fresh page state
   - manual login/CAPTCHA/2FA/consent steps are recorded as non-executable evidence and never advance the learned action boundary
   - Session → Skill compilation rejects sessions crossing manual handoffs instead of pretending the human-only precondition is automated
   - verified gate: 201/201 extension tests across 42 files + 3/3 Bridge tests; typecheck/build/MV3/contract/package PASS
   - back/reload — verified through the same bounded navigation-readiness contract
   - close_session — verified task-owned cleanup; borrowed user tabs are preserved
6. **Versioned Skill lifecycle + refinement — verified at `e23be905d190f60aaecee916dc031eaa0c1a1380` (CI `36374874922`)**
   - immutable candidate revision history with explicit parent links
   - successful/failed runs persist inspectable execution evidence without parameter values
   - partial failed-run progress and bounded error codes/messages are retained for diagnosis
   - failed/drifted runs return `refinement_recommended` and `next_action: site_skill refine`
   - `site_skill refine` recollects fresh evidence, computes a deterministic contract diff and creates a new candidate revision only when the contract changed
   - active revisions are never silently mutated or replaced by refinement
   - `site_skill compare` reports candidate-vs-active execution counts, pass/fail rates, latest outcomes and deterministic regression/improvement signals
   - explicit promotion requires passing latest structural + execution evaluation for the same revision
   - explicit rollback only targets a previously active revision
   - no auto-promotion
7. **v0.3 Memory foundation — working + episodic + automatic recall verified**
   - durable structured task episodes verified at `72c2efa34ac106c42f5dc81001002216415acce0` (CI `36375186790`)
   - active-session working memory verified at `664ca6552c50aa51cea66c905535bc33b900bac7` (CI `36375649476`)
   - automatic bounded recall verified at `55f17d18ecc88f8cbf79db2f984f133343642df8` (CI `36375686902`)
   - working memory updates automatically after meaningful actions/handoffs and stores no raw tool-input payloads
   - final task state rolls into durable episodic memory before working state is retired
   - episodic memory keeps task outcome, sites, tools, semantic targets, handoffs and Skill/revision references while excluding typed/uploaded parameter payloads
   - task-start recall uses current goal + hostname, returns at most three episodes and labels them historical evidence only
   - `memory` tool exposes current-session active memory plus bounded search/list/get/delete of durable episodes
   - Local Bridge surface: **34 tools**; BrowserHarness runtime surface: **35 tools** including orchestrator-only human handoff
8. **Semantic episodic memory — verified at `54844255e208fccf46867d85eb3f78cacb6fb4a6` (CI `36376927539`)**
   - dedicated first-class embedding connections with independent health/routing
   - embedding-only models cannot accidentally become chat primary/fallback routes
   - OpenAI/NVIDIA/OpenAI-compatible `/embeddings` support with finite-vector + consistent-dimension validation
   - sanitized episode vector index is provider/model/content-hash aware
   - hybrid lexical + cosine semantic retrieval with inspectable rank/similarity metadata
   - automatic recall now uses hybrid retrieval and remains capped at three historical episodes
   - embedding endpoint failure degrades to lexical retrieval instead of failing the browser task
   - raw action inputs, typed values, upload paths and Skill parameter values are never embedded
9. **Procedural memory — verified at `aa0cc7e64bbcbaa0eaef53b92687acb05710fe84` (CI `36377638107`)**
   - retrieval preserves exact immutable Site Skill + revision provenance
   - active revision and newer candidate remain separate procedures when they differ
   - each procedure exposes lifecycle state, structural verification, latest execution, execution counts/success rate, promotion gate, parameter contract and recipe/step contract
   - hybrid lexical + semantic retrieval with lexical fallback on embedding failure
   - active/proven evidence contributes only a tiny explicit near-tie preference; relevance ranking remains authoritative
   - task-start procedure recall is capped at three
   - `memory procedures` exposes the same revision-aware retrieval to Bridge/external agents
   - procedural retrieval must never execute implicitly; the planner must explicitly call `site_skill run` with the exact revision after checking the current goal and fresh page
   - CI: 240/240 extension tests across 48 files; typecheck/build/MV3/contract/package PASS
10. **MCP stdio server — verified at `ea4433d7efacb760bf5aab060a9f96b9e72c3b25` (CI `36377928834`)**
   - `browserharness-bridge mcp` serves MCP over stdio using the current v2 server SDK
   - exposes `browserharness_status` plus all 34 Local Bridge browser actions as MCP tools
   - every action relays through authenticated loopback `POST /command` and the paired extension; MCP is not a second browser executor
   - stable MCP session id maps directly to BrowserHarness task-session ownership
   - `APPROVAL_REQUIRED` and other Bridge failures remain visible MCP tool errors
   - non-loopback Bridge targets are rejected; stdout remains protocol-only
   - verified gate: 9/9 Bridge tests + 240/240 extension tests; build/contracts/package PASS
11. **Outbound MCP client + productization — verified at `d116cb410dc179994f22bbb035028e6a053b35ba` (CI `36381759745`)**
   - daemon accepts familiar `mcpServers` stdio configuration and owns all external process lifetimes
   - environment-variable values stay daemon-side; Chrome/model surfaces see only server metadata and environment key names
   - extension `mcp` tool supports server discovery, fresh tool discovery and tool execution through the paired Bridge WebSocket
   - mutating/unannotated tools require the existing privileged BrowserHarness approval retry; daemon also rejects unapproved mutating calls
   - per-server trust modes: allow read-only / ask all / blocked
   - Settings shows configured servers, connection state, tool annotations and per-server trust policy
   - external MCP call arguments are redacted from BrowserTaskSessionEvidence
   - planner receives a task-ranked catalog capped at 6 servers / 18 tools with explicit approval metadata; blocked servers are excluded
   - external MCP descriptions/results remain untrusted data and cannot override user goals or BrowserHarness policy
12. **Supervisor + bounded read-only subagents — verified at `a159bef5c3c086d9b18f0afd5d0af49fcbccf5b1` (CI `36382897733`)**
   - supervisor `agent` delegation is orchestrator-only and never Bridge-exposed
   - each worker receives an isolated child BrowserHarness task session with a hard maximum of 8 steps
   - borrowed current tab is read-only; independent navigation requires a worker-owned background tab
   - worker-owned tabs are automatically cleaned by child `close_session` in `finally`
   - code-level policy rejects click/type/upload/submit/raw-CDP/Skill mutation and recursive `agent`
   - workers never receive or forward BrowserHarness approval proofs; mutating/unannotated MCP calls cannot execute
   - worker planner advertises only the bounded read-only surface and uses normal primary/fallback model routing
   - findings return status/message plus up to 6 source URL/title records and up to 20 tools used
   - verified gate: 16/16 Bridge tests + 263/263 extension tests across 53 files; typecheck/build/MV3/contracts/package PASS
   - runtime surface: **37 tools** = 35 service-worker tools + orchestrator-only `agent` + `await_user_action`
13. **Parallel supervisor research + provenance merge — verified at `d572e84d7a5344b03052f6a7b6d9343423cc1dc1` (CI `36383377960`)**
   - one `agent` delegation supports one task or up to two independent `tasks[]`
   - workers launch concurrently with distinct child sessions and independent 8-step limits
   - duplicate delegated tasks are removed and >2 workers are rejected explicitly
   - merge order is deterministic and follows supervisor input order, not completion timing
   - one worker failure is retained as evidence and does not discard a successful sibling
   - parent session evidence stores bounded child-session/task/status/source/tool provenance
   - worker internals/raw external payloads are not copied into parent evidence
   - verified gate: 16/16 Bridge tests + 267/267 extension tests across 54 files; typecheck/build/MV3/contracts/package PASS
14. **Delegation-aware memory + supervisor synthesis evidence — next active engineering target**
   - carry child-worker tasks/sources/status into durable episodic memory
   - include delegated source provenance in semantic retrieval text without copying worker raw payloads
   - preserve which prior conclusions were supported by which child sources
   - make recalled delegation evidence explicit historical context, never authority
15. **Task DAG + verifier workers — after delegation memory**
   - explicit dependency graph for multi-step delegated research
   - verifier workers receive evidence but no mutation authority
   - independent verification of important worker claims before supervisor synthesis
16. **SK-BROWSER-001 v0.3.0 cross-runtime evaluation — parallel external-runtime blocker**
   - run the existing 25-case evaluation only when a real external agent runtime is paired to BrowserHarness Local Bridge
   - do not substitute product unit tests or fabricate cross-runtime results

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
- real CDP hover + drag/drop with target/delivery verification
- OS-aware modifier chords/sequences via send_keys
- bounded back/reload navigation
- task-owned close_session cleanup with borrowed-tab preservation
- human handoff for login/CAPTCHA/2FA/manual consent

### Browser capability rule
BrowserHarness is an autonomous browser agent. Functionality and reliability take priority over minimizing the permission envelope.

The primary BrowserHarness build now intentionally targets the proven high-capability browser-agent surface:
- debugger / Chrome DevTools Protocol
- <all_urls>
- webNavigation
- webRequest
- unlimitedStorage
- windows / tabs / tabGroups
- scripting
- alarms / notifications / context menus

The permissions must map to real BrowserHarness capabilities and remain covered by automated tests, but they are no longer deferred into a separate reduced-capability edition.

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
