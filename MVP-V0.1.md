# BrowserCrew v0.1 MVP Contract

**Status:** approved scope  
**Priority:** ship a useful product fast.

## Product promise
A user can install BrowserCrew, connect a supported AI provider, open any normal webpage, ask BrowserCrew to perform a browser task, watch its actions, and approve consequential actions before they happen.

## Primary UX
Chat is the product. Advanced configuration is progressively revealed through Settings or contextual controls.

Persistent chat controls:
- current tab/context;
- model selector;
- workspace selector;
- Record / Watch Me;
- settings.

## Supported providers
1. OpenAI
2. Anthropic
3. NVIDIA hosted NIM
4. OpenAI-compatible endpoint

Where a provider exposes an OpenAI-compatible `/models` endpoint, BrowserCrew should discover available model IDs automatically after credentials are entered and present them in a searchable selector. Manual model entry remains available as a fallback.

Other providers/local runtimes are post-MVP unless they can be added through the compatible adapter without delaying release.

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

## Required product behavior
- one agent;
- may operate multiple tabs;
- activity shown as structured events, not hidden reasoning;
- user can pause/stop immediately;
- mutations are verified after execution;
- send/publish/submit/purchase/delete/security-changing actions require approval by default;
- task history is local-first;
- API/provider configuration remains on-device for v0.1;
- webpage/retrieved text is untrusted input.

## Watch Me MVP
Record semantic browser actions, save them as a named workflow, and replay them. Generalization, automatic Skill promotion and self-improvement are post-MVP.

## Settings
- Models
- Connections
- Workspaces
- Agents
- Skills
- Workflows
- Memory
- Browser Access
- Permissions
- Privacy
- Appearance
- Advanced
- About

Only Models/Connections, Browser Access, Permissions, Privacy and Appearance need full MVP functionality. Other sections may be progressive placeholders if not needed by release scenarios.

## Release acceptance scenarios
1. Summarize the current page.
2. Navigate a site to a requested destination.
3. Search within a site.
4. Fill a form without submitting.
5. Open multiple items in tabs and compare them.
6. Stop for approval before a consequential action.
7. Record and replay a simple workflow.
8. Pause and stop an active run.
9. Recover once from a stale/missing element by re-observing.
10. No API keys or raw page content in analytics/log output.

## Non-goals
Multi-agent teams, deep memory, Skill marketplace, automatic Skill promotion, MCP, scheduling, cloud sync, team admin, enterprise controls and BrowserCrew-hosted inference.

## Ship rule
If a proposed feature does not improve one of the acceptance scenarios above, it does not block v0.1.
