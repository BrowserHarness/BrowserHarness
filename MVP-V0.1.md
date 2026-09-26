# BrowserCrew v0.1 MVP Contract

**Status:** automated implementation complete; final real-Chrome acceptance pending  
**Priority:** ship a useful product fast.

## Product promise
A user can install BrowserCrew, connect a supported AI provider, open a normal webpage, give BrowserCrew a browser task, watch structured activity, and approve consequential actions before they happen.

## Verified automated baseline
- Product code SHA: `76218f69e16afae0f079d0cf4b4956754df39dfa`
- GitHub Actions run: `36262532519`
- Result: **success**
- Unit/regression tests: **63/63 across 14 files**
- TypeScript: **PASS**
- Production build: **PASS**
- MV3 validation: **PASS**
- MVP automated contract gate: **PASS**
- ZIP packaging/upload: **PASS**

## Primary UX
Chat is the product. Settings and secondary surfaces are progressively disclosed.

Persistent surfaces now include:
- current tab/context;
- validated Primary/Fallback model routing;
- Chat vs Browser-Agent runtime separation;
- task history;
- Record / Watch Me;
- Settings.

## Supported provider paths
1. OpenAI
2. Anthropic
3. NVIDIA hosted NIM
4. OpenAI-compatible endpoints, including Groq

BrowserCrew supports:
- automatic model discovery where a compatible `/models` endpoint exists;
- capability classification;
- separate Chat and Agent health probes;
- multiple saved connections;
- one Primary plus at most one validated Fallback;
- bounded failover for recoverable provider/model failures.

## Browser tools
- observe_page
- navigate
- click
- type
- press_key
- scroll
- wait
- open_tab
- switch_tab
- close_tab
- screenshot

Vision-capable Agent models can consume a captured screenshot on the next planning turn when DOM/text evidence is insufficient. Screenshot evidence is visual context only; browser mutations still require semantic page controls.

## Required product behavior
Implemented:
- one browser agent;
- multi-tab operation with retained observed-tab evidence;
- structured activity instead of hidden reasoning;
- pause/stop;
- mutation verification;
- stale-element re-observation;
- duplicate-action loop protection;
- bounded steps/retries;
- consequential-action approvals;
- local task history with privacy retention control;
- local Watch Me workflow persistence/replay;
- API/provider configuration stored locally;
- webpage/retrieved text treated as untrusted input;
- optional website permission model rather than blanket install-time host access;
- functional Browser Access, Permissions, Privacy, and Appearance settings;
- Google Docs behind an explicit site-adapter boundary.

## Release acceptance scenarios
Automated engine coverage now exists for:
1. current-page read;
2. navigation + verification;
3. site search;
4. form fill without submission;
5. multi-tab retained evidence/comparison support;
6. approval cancellation before consequential action;
7. pause/stop execution gates;
8. Watch Me workflow persistence contract;
9. stale-element recovery;
10. unsupported/protected-page failure.

Additional automated coverage includes provider fallback, 429 handling, model discovery/capabilities, screenshot vision handoff, task-history privacy, permissions, manifest security posture, and packaging.

## Manual acceptance still required
CI cannot prove live Chrome/provider/site behavior. Before public release, one final real-Chrome pass must verify:
- unpacked packaged extension loads cleanly;
- at least one live provider/model passes Chat + Agent health checks;
- website permission prompts behave correctly;
- one normal browser task executes end-to-end;
- Google Docs insertion works in the current Docs implementation;
- Watch Me captures and replays real DOM events;
- consequential approval UI works on a real site;
- a vision model consumes a real captured screenshot if vision is included in release acceptance.

## Non-goals
Multi-agent teams, deep semantic/episodic memory, Skill marketplace, automatic Skill promotion, MCP, scheduling, cloud sync, team administration, BrowserCrew-hosted inference, audio/image-generation execution, and more than one fallback hop.

## Ship rule
No post-MVP features block v0.1. Public release requires the final real-Chrome acceptance pass after this automated-complete baseline.
