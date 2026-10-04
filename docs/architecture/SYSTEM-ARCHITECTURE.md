# BrowserHarness System Architecture

## Runtime layers
1. Chrome extension surfaces and service worker.
2. Browser harness: tabs, navigation, DOM/accessibility observation, screenshots and actions.
3. Tab manager: ownership, locks, snapshots and lifecycle.
4. Tool runtime: provider-neutral browser/tool contracts.
5. Skill runtime: versioned reusable capabilities.
6. Agent runtime: planning, execution, verification and scoped memory.
7. Orchestrator: supervisor, task graph, worker pool and event bus.
8. Model router: capability/cost/privacy-driven provider selection.
9. Memory runtime: working, episodic, semantic and procedural memory.
10. Watch Me & Learn: demonstration capture → workflow inference → Skill candidate.
11. Safety: permissions, autonomy, approvals, prompt-injection defense and audit evidence.

## Multi-agent rule
A task may use multiple agents and tabs. Mutating tab control is exclusive by default. Agents communicate through structured task outputs/events before unrestricted chat.

## Self-improvement rule
A successful recovery may create an improvement candidate, never silently overwrite the active Skill. Candidate → evaluation → promotion → rollback-capable version.
