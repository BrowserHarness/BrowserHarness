# ADR 0001: Native API Engine v1 (API Anything inside BrowserHarness)

**Status:** accepted, 2026-10-10
**Baseline:** BrowserHarness `main` at `5f61b5f2e963a3525abdd7490de8f1c984b5d47b` (unchanged since the brief was written)
**Upstream reference:** [goodnight000/api-anything](https://github.com/goodnight000/api-anything) at `fe5cca70fe145634e49a1c9ba1f3e8250b291bea`, MIT licensed

## Context

BrowserHarness drives websites through its browser runtime. Its Site Skills already learn forms and same-origin JSON GET requests from one page visit (`runtime/site-skill-api.ts`), run them in the page with the page's cookies, keep immutable revisions, and promote or roll back only through evaluation. What it cannot do is learn a request with real parameters in it: a search hidden in a POST body, a GraphQL variable, a value inside a JSON string inside a form field. It also has one transport (in-page fetch), no failure classes beyond HTTP status, and no way to repair a learned request when a site rotates an id.

API Anything solves exactly that. It learns an operation from two example runs, fills parameters through decoded layers without string replacement, classifies failures (ok, drift, auth, rate, blocked, input, error), runs a three-tier ladder (Node fetch, in-page fetch, trigger run) and heals drift reactively. It is a standalone tool with its own Playwright browser, cookie store and spec files.

## What BrowserHarness already implements

| Area | Where | Notes |
|---|---|---|
| CDP network capture with request headers and POST bodies | `background/network-capture.ts` | No resource type, no response bodies kept, no page storage snapshot |
| In-page authenticated fetch | `runtime/site-skill-api.ts` `apiFetchExpression`, `background/page-evaluate.ts` | GET only, same origin, query parameters only |
| Site Skill contract, revisions, evaluation, promotion, rollback, refinement | `runtime/site-skill*.ts` | One registry: `browserharness.siteSkillLibrary.v2` |
| Site Commands (side panel, agent, MCP, CLI) | `runtime/site-commands.ts`, Bridge `site_commands` | Already list API recipes as `read` commands |
| Procedural memory over Site Skill revisions | `runtime/procedural-memory.ts` | Revision-exact, never executes implicitly |
| Task DAG with read-only workers | `runtime/task-dag.ts`, `subagent-policy.ts` | Workers may not run `site_skill` today |
| Outbound MCP client, trust modes, approval retry | Bridge `mcp-client.mjs`, extension `mcp-tools.ts`, `mcp-catalog.ts` | stdio servers from `~/.browserharness-bridge/mcp-servers.json` |
| Approvals | `options.approvalGranted`, `APPROVAL_REQUIRED` | Extension-page proof only |

## What is genuinely missing

1. Parameter inference across decoded layers (query, path, form, JSON, JSON in strings, base64 JSON, GraphQL variables) and the two-run diff.
2. Response extraction beyond "return the JSON" (extract paths, picks, HTML and embedded-JSON recipes, shape for drift).
3. Failure classification that separates auth, rate limit, bot wall, input and drift.
4. Direct HTTP execution outside the browser, and a dispatcher that picks a transport per operation.
5. Session references (a cookie or token named in the template, filled at call time) instead of literal values.
6. Drift detection and repair that produces a candidate revision.
7. Learning from Watch Me and a way for agents and DAG workers to call learned operations.

## Decision

### 1. Reuse upstream code by vendoring the compiled modules

`apps/bridge/vendor/api-anything/` holds upstream's compiled `dist/*.js`, its bundled `sites/`, `LICENSE` and `VENDORED.json` (commit, file hashes, the one patch). `scripts/vendor-api-anything.mjs` reproduces it from the pinned commit and `npm run vendor:check` verifies the hashes.

Why vendoring and not an npm dependency: the package is not on npm, `npm install github:...` fails under npm 11 (upstream README), and the Bridge ships as one esbuild file installed without network access to GitHub. Vendoring the compiled output keeps the code byte-for-byte reviewable against the commit.

One patch: `browser.js` imports `playwright-core`. BrowserHarness has one browser runtime, the extension, so the vendored copy imports `./playwright-unavailable.js`, which throws `BROWSERHARNESS_BROWSER_TIER_UNAVAILABLE`. Upstream's own tiers 2 and 3, its capture, its login window and its Chrome profile never run inside BrowserHarness.

Used directly (unchanged): `codec` (decoded-layer walk and fill), `learn` (`learnOperation`, `rankCandidates`, `matches`), `classify` (`judge`, `botWall`), `extract` (`extract`, `capOutput`, `inferShape`), `http` (`buildRequest`, `send`, `nextHop` redirect policy, pacing), `secrets` (`scanSecrets`), `spec` (zod schemas), `outline`, `session` helpers (`siteOf`, `parseSetCookie`, `cookieHeaderFor`).

Adapted: `execute.call` becomes the Bridge dispatcher (same order and rules, but tier 2 and 3 are extension commands and transport memory lives in the Site Skill). `heal.healOperation` becomes the repair coordinator (recapture through the extension, `learnOperation` with the call's args, validation by replay, result saved as a candidate revision, never written over the active one). `mcp.ts` is re-hosted on the Bridge's MCP v2 server SDK so the Bridge does not carry two MCP SDK majors.

Not introduced: upstream's Playwright browser and profile (`browser.ts` tiers, `capture`, `login --window`), browser cookie-database import (`import.ts`, reading other browser profiles), its spec store as a second skill registry, its CLI `add`/`heal` as a user surface, and its `~/.api-anything` home (the compatibility adapter uses `~/.browserharness-bridge/api-anything`).

### 2. Node version

The Bridge keeps `engines: >=20`. The vendored modules used by the native engine load on Node 20 (checked by `apps/bridge/test/api-engine-node.test.mjs` under the running Node, and by hand on 20.20.2). Upstream declares 22.13 for `node:sqlite`, which only its cookie import uses; that path is not part of BrowserHarness. The packaged helper already ships Node 22.22.0. The compatibility adapter reports `API_ANYTHING_NODE_UNSUPPORTED` below Node 20, and nothing silently changes for existing installs.

### 3. Where each part runs

| Part | Owner |
|---|---|
| Recording controls, task tabs, CDP capture, in-page fetch, trigger runs, approvals, Skills UI | Extension |
| Learning (`learnOperation`), request building, direct HTTP, classification, extraction, dispatcher, transport choice, rate pacing, repair coordination, diagnostics | Bridge `src/api-engine/` |
| API Recipe v2 contract, revisions, evaluation, promotion, rollback, commands | Site Skill runtime |
| Skill selection, DAG workers, procedural recall, provenance | Agent and memory runtime |

The extension asks the Bridge over the existing paired WebSocket (`api_request` / `api_result`, like `mcp_request`). The Bridge asks the extension for browser work with `command` messages flagged `internal: true` (`api_page_fetch`, `api_trigger_capture`, `api_session_cookies`). `POST /command` cannot set that flag, so external agents cannot call these directly. No second daemon, no second browser.

Without a paired Bridge, an API v2 recipe answers `API_ENGINE_UNAVAILABLE`; a hybrid Skill falls back to its UI recipe through the existing path. Legacy `api_fetch` recipes keep running in the extension as before.

### 4. One Site Skill registry: API Recipe v2

A recipe gains an optional `kind` (`ui`, `api`, `hybrid`) and a new step kind `api_operation` that carries a versioned operation contract (`contract_version: 2`). Existing recipes and steps are unchanged and still load. See `docs/protocols/API-RECIPE-V2.md`.

Learned operations are saved with the existing `saveSiteSkillCandidate`, evaluated with `recordSiteSkillEvaluation`, promoted and rolled back with the existing gate. Repairs are new revisions with reason `repair`. Nothing auto-promotes.

### 5. Credentials

Templates never hold credential values: upstream's learner turns them into `cookie:` and `session:` references and its save-time scan refuses a spec that still holds one. At call time the Bridge asks the extension for the cookies of the operation's own registrable domain (CDP `Network.getCookies` in the calling task's tab, this Chrome profile only) and holds them for that call only. `session:` values come from the page at tier 2. Nothing is written to `~/.browserharness-bridge`, Site Skills, memory, embeddings or logs. Other browser profiles are never read. Site Skills stay shared across Spaces (site knowledge, `MEMORY-V2.md`), and execution evidence, episodes and procedural recall keep their existing scoping.

### 6. Side effects

`side_effect` is `read`, `write` or `unknown`, set conservatively: a GraphQL `mutation`, a non-GET request without a read signal, or a GET to a path that looks like an action is `unknown`. `unknown` is handled as `write`: approval proof required, sent once, never retried on an ambiguous outcome, never sent to learn it, no tier 3. Only the person can mark an operation `read` (Skills view, or `site_skill classify_api` with approval proof).

## Consequences

- One browser runtime and one skill registry, with upstream's learner and classifier doing the hard parts.
- The Bridge becomes required for API v2 recipes. This matches its role as the local execution host, and the extension degrades to the UI recipe without it.
- Upstream fixes reach BrowserHarness by re-running the vendor script at a new reviewed commit.
- Real-site acceptance (authenticated reads, real drift) cannot be proven in this environment. It is listed in the final report as a release-candidate step, not claimed.
