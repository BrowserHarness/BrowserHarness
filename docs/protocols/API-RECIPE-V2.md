# API Recipe v2

Status: implemented for reads (learning, unseen-input verification, health checks, repair) and for running at all three tiers. Watch Me learning of writes is a later work package (see `docs/architecture/API-ENGINE-ADR.md`).

An API Recipe v2 is a Site Skill recipe whose one step is a learned website operation: the request a page makes when someone uses it (a search, a lookup, a GraphQL query), with where each input goes, where each credential comes from, what the answer looks like, and how it was checked. It lives in the same Site Skill library as form recipes, with the same revisions, evaluations, promotion gate and rollback. There is one registry.

## Where it sits

```
SiteCandidateSkill (schema_version 1)
└─ recipes[]
   ├─ form recipe          steps: input… submit         kind: ui
   ├─ api_fetch recipe     steps: api_fetch (GET, v1)   kind: api
   └─ API Recipe v2        steps: api_operation         kind: api
                           form_index: -1
                           id: recipe-api-v2-<operation hash>
```

`recipe.kind` (`ui`, `api`, `hybrid`) is optional and derived from the steps when absent. Older recipes are unchanged and load as before.

The step:

```json
{ "kind": "api_operation", "contract": { ... }, "approval": "none_read_only" }
```

`approval` is `none_read_only` only when the contract's `side_effect` is `read`. Anything else is `browserharness_runtime`: `site_skill run` returns `APPROVAL_REQUIRED` until the person approves it.

## The contract

Owned by the Bridge (`apps/bridge/src/api-engine/recipe.mjs`, zod schema `ApiOperationContractSchema`); the extension mirrors it as `ApiOperationContract` (`apps/extension/src/runtime/api-recipe.ts`). `request`, `slots`, `volatile`, `params`, `response`, `match` and `trigger` are API Anything's operation parts at the vendored commit, unchanged, so the vendored codec, HTTP sender and classifier work on them directly.

| Field | Meaning |
|---|---|
| `contract_version` | `2` |
| `operation_id` | `op-` + 16 hex of sha256(origin, name, match). Stable across rotating ids and hashes. |
| `name`, `description` | Operation name (`search`) and an optional sentence. |
| `origin` | `https://host[:port]` the request goes to. |
| `side_effect` | `read`, `write` or `unknown`. `unknown` is treated as a write everywhere. |
| `side_effect_basis` | Why: "GET without an action-looking path", "GraphQL query", "POST to a search-like path /api/search", "declared a write by the person"… The HTTP method alone never makes something a read. |
| `request` | The captured request as a template: method, URL, kept headers, body. Example values are still in it; slots overwrite them. No `cookie` header. |
| `slots[]` | Where each input goes: `{param, at, template?}`; `at` is a path of steps (`query:q`, `path:2`, `form:f.req`, `header:x`, `body`, `json:/variables/filter/term`, `b64`). A slot with `ref` is a credential reference instead. |
| `volatile[]` | Values that change per page load (nonces, signatures) and how they are re-derived. |
| `params[]` | `{name, type, required, example?, default?, pattern?}`. An example the person typed is kept for health checks unless named in `private_params` at learning time. A private param's learning value is also taken out of `request`: each of its slots holds a placeholder (`{name}`, or `0`/`false` for numbers and booleans), which every run overwrites. |
| `session_refs[]` | Names of `cookie:<name>` and `session:<op>/<key>` references. Names only. |
| `session_sources[]` | Where each reference's value comes from at call time: `cookie` (by name), `storage` (a page localStorage/sessionStorage key, optionally a JSON path inside it) or `page` (a value only the page's own script produces, so only tiers 2 and 3 can send it). |
| `public[]` | Header or field names a person marked as public constants. |
| `response` | How to read the answer: `format`, `extract` (a path such as `data.search.products`), `pick`, `shape` (key paths and types, for drift detection). |
| `match` | Stable identity of the request (method, host, path with `*` segments, GraphQL operationName). Never a query hash. |
| `trigger` | The page that makes the request, with `{param}` holes: `https://shop.example/search?q={q}`. |
| `min_tier` | `1` when plain HTTP can send it; `3` when the two runs showed values that change per load with no input change. |
| `learned_logged_in` | Whether the learning runs looked signed in. |
| `transport` | `{preference: [1,2,3], learned_tier?}`; `learned_tier` is the tier that last answered. |
| `verification` | `{status: unverified|verified|failed, checks[]}`; see below. |
| `provenance` | `{source, engine, learned_at, evidence_ids, warnings, parent_operation_id?, example_inputs?}`. `engine` names this engine and the vendored upstream commit. `example_inputs` holds the inputs a person typed to teach it (`learning`, and `unseen` once it verified), for health checks and repair; it is left out when any param was marked private. A repair sets `source: "repair"` and `parent_operation_id`. |

A contract never holds a cookie value, a token, a password, a session storage value or a response body. The learner runs upstream's secret scan over the finished contract with every cookie and storage value from both runs, and refuses to return it (`API_LEARN_SECRET`) if any of them appears anywhere in it.

A complete example learned from the local fixture shop is `apps/extension/src/runtime/api-recipe.fixture.ts`.

## Learning (`site_skill learn_api`)

Input:

```json
{
  "action": "learn_api",
  "name": "search",
  "page_url": "https://shop.example/search?q={q}",
  "examples": [{ "q": "laptops" }, { "q": "keyboards" }],
  "verify_args": { "q": "monitors" },
  "id": "optional: add to this Site Skill",
  "skill_name": "optional: name for a new Site Skill"
}
```

1. The extension opens `page_url` filled with each example in a background tab the task owns, records the network from before the page loads until it has been quiet for 1.2 s, reads the run's cookies (CDP `Network.getCookies`, no `cookies` permission) and page storage, and closes the tab.
2. It sends both runs to the Bridge in one `api_request` (`learn`). The Bridge converts them to upstream's capture shape and runs upstream's deterministic learner: rank the requests carrying the example values, place each param, turn live cookie and storage values into references, diff the two runs for nonces, build the match and learn the response recipe. No model is used.
3. The Bridge judges each run's own answer with the learned recipe (`learned_examples` checks), then calls the operation live with `verify_args` (`unseen_input`). The check passes only when the call succeeds, finds items, and its data differs from both learning runs' data, so a recipe whose input never reaches the request cannot pass. An input that repeats an example is refused.
4. The captures, cookies and storage values are dropped. The extension saves a new candidate revision (`create`, or `refinement` when adding to an existing Skill), records a structural-verification evaluation (the contract checks) and an execution evaluation plus execution evidence (the live unseen-input call). Nothing is promoted: `site_skill promote` still needs both latest evaluations to have passed and the person to ask.

Writes are not learned this way. `side_effect: "write"` is refused with `API_LEARN_WRITE_REFUSED` before any page opens, because running a page twice would send the write twice. Writes are learned from a demonstration the person makes (below).

### From Watch Me (`from_watch`)

While Watch Me records, the recorded tab's network is captured (the capture starts at `WATCH_START` unless one is already running on that tab). At `WATCH_STOP` the extension waits for the network to settle, reads the capture, cookies and page storage as above, and keeps them **in memory only** for 15 minutes, with the values the person typed (password, one-time code, card and token fields are skipped). The `WATCH_STOP` answer gets `api_capture: {recording_id, data_requests, inputs, kept_minutes, next}`: counts and input names, no values. The side panel says so after saving the workflow.

```json
{ "action": "learn_api", "name": "search", "from_watch": ["<recording id>", "<second recording id>"], "verify_args": { "search": "monitors" } }
```

- One or two recordings. With two, the inputs are the fields typed differently in each; with one, every typed field is an input and the learner warns that nonces could not be told apart. `examples` overrides what was typed (one per recording).
- `page_url` is optional; without it the trigger page is the recorded page whose address carries what was typed, templated by the Bridge. A search done entirely in-page (no address change) gets a trigger page with no `{input}`, so tier 3 cannot replay it: give `page_url` for that.
- Reads with `verify_args` get the same live unseen-input check as above. Without it they are saved `unverified`.
- `side_effect: "write"` is allowed here: the person already sent it. It is never sent again to check it (saved `unverified`), every run asks first, and its typed inputs are made private by default (no example values kept anywhere in the contract). The Bridge still refuses a write when `automated_trigger` is set.
- `provenance.source` is `watch_me`; the evidence id is `watch-<recording id>`. A capture is forgotten once learned from, or after 15 minutes. `API_LEARN_WATCH_MISSING` when it is gone (or the service worker restarted).

Errors: `API_LEARN_INPUT` (bad name, page_url without a `{param}` for each input, fewer than two examples, equal examples, no `verify_args`), `API_LEARN_RUN_FAILED` (a page did not load), `API_LEARN_FAILED` (no request carried the inputs; the error carries the ranked candidate requests, origin and path only), `API_LEARN_SECRET`, `API_ENGINE_UNAVAILABLE` (no helper app).

## Running: three tiers

`site_skill run` with an API Recipe v2 recipe needs no tab of the person's. Reads run at once; anything else asks first. Every answer comes from a request made for that call; nothing returns a stored or example response.

| Tier | Who sends it | Session | When it cannot |
|---|---|---|---|
| 1 | The Bridge, plain HTTP | none from the browser (no cookie export) | `min_tier` above 1, a page-only value, or a reference with no value (`unavailable`/`auth`, nothing sent) |
| 2 | A page of the site: a background tab on the trigger page's origin (`/robots.txt`, a light same-origin document; the home page if that one leaves the origin; never a page that ended up on another origin, which answers `unavailable` with nothing sent) runs `fetch()` with `credentials: "include"` and `redirect: "manual"` | the browser's own cookies; storage references read from that page for this call | `min_tier` 3, or a page-only header |
| 3 | The site's own page: a background tab loads the trigger URL with the inputs, BrowserHarness records the network and the Bridge finds the request matching the operation and judges its answer | everything the page has | writes, and triggers with UI steps (not replayed yet) |

The Bridge builds every request (`page_request`), judges every answer (`call`, `page_answer`, `page_run`) and applies tier 1's redirect policy; the extension only does what needs the browser. Tabs opened for tiers 2 and 3 are closed after the call.

The dispatcher (`apps/extension/src/runtime/api-dispatch.ts`):

- Order: `transport.preference` (default 1, 2, 3), never below `min_tier`, with the tier that last answered for this operation first (remembered in `browserharness.apiTransport.v1`, a number per operation id, no values; separate from the immutable revision).
- A read moves to the next tier on `unavailable`, `auth`, `blocked` or `network`. It stops on `input`, `rate_limited`, `schema_drift`, `endpoint_drift` and `approval_required`.
- A write gets one attempt that reaches the site. It moves on only when nothing was sent (`sent: false` with `unavailable` or `auth`). Anything else, including a transport that threw, ends the call; a failure after sending is `ambiguous_write` with `next` saying to check the site.
- The result carries `attempts[]`: tier, class, whether it was sent, reason, time.

The live unseen-input check at learning time goes through the same dispatcher, so a signed-in read verifies in the page (tier 2) and a request with a per-load signature verifies through the page itself (tier 3). The Bridge's `verify` action judges the answer the extension got.

Site commands built from these recipes carry `needs_page: false`, so `site_commands` and `browserharness-bridge site <name>` run them without opening the site. A learned write is listed as a form-like command, which asks for approval.

## Results

Every tier returns the same shape:

```json
{
  "ok": true, "class": "ok", "tier": 1, "sent": true, "status": 200, "ms": 41,
  "data": [ ... ], "item_count": 2, "truncated": "only when capped",
  "reason": "on failure", "next": "on failure, what to do",
  "operation_id": "op-…", "fetched_at": "ISO time", "fresh": true,
  "attempts": [{ "tier": 1, "class": "auth", "sent": true }, { "tier": 2, "class": "ok", "sent": true }]
}
```

Classes: `ok`, `input` (bad or missing input; nothing sent), `auth` (signed out, or a credential reference with no value), `rate_limited`, `blocked` (bot wall or bare 403), `network` (no answer to a read), `schema_drift` (answered without the data), `endpoint_drift` (404/405/410/501, or a redirect off the operation), `ambiguous_write` (a write that may have run: never resent; `next` says to check the site), `approval_required`, `unavailable` (this tier cannot send it: per-load values, or a page-only header).

## Health and repair

`site_skill verify` on a Skill whose recipes are all learned operations (or with a `recipe_id` naming one) calls each read live through the dispatcher with its taught third input (else its first learning input, else the params' examples) and records one structural-verification evaluation: passed only when every checked read answered with items. Writes are skipped, never sent to check them.

When a run fails with `schema_drift` or `endpoint_drift`, the failure says `repair_recommended: true` and `next_action: site_skill repair`. Other classes say what to do: sign in (auth), wait (rate limited), open the site once (blocked), check the site and do not resend (ambiguous write).

`site_skill repair` (`id`, `recipe_id` when the Skill has several learned operations, optional `examples`, `verify_args`, `page_url`):

1. Refuses writes (`API_REPAIR_WRITE`): a write is re-taught by a person.
2. Is bounded per operation of a Skill (`browserharness.apiRepair.v1`): at most 3 attempts in 24 hours, a 60-minute pause after a failed one, 5 minutes between any two (`API_REPAIR_COOLDOWN` with `retry_after_minutes`).
3. Learns the operation again from its trigger page with the taught inputs (two runs, the learner, the live third-input check), exactly as `learn_api`, with `source: "repair"` and `parent_operation_id` set.
4. Saves the result as a new candidate revision in which the new recipe takes the old one's place. The active revision is never changed; `site_skill compare` and `promote` decide, behind the usual gate. The answer lists what changed in plain words (`path /api/search → /api/v2/search`, `results read from products (was items)`).

Failures from the Bridge carry their `data` (next action, failure class) through `/command` and MCP, not only the error.

## Planning, helpers and memory

- Site Commands for learned operations say `runs_without_page: true` (`needs_page: false`), with `recipe_kind` and `api {operation_id, side_effect, verification, learned_tier, min_tier}`. The agent prompt tells the model to prefer a proven API read command over driving the page for reads, and to keep the page for writes and anything the person should see.
- Task DAG helpers (read-only workers) may call `site_skill run`. The worker policy forwards it with `api_read_only: true`; the service worker then runs it only if the selected recipe is an `api_operation` whose contract is a read, never with approval, and refuses anything else with `SUBAGENT_SCOPE_DENIED`. A helper still cannot learn, repair, promote or run a form.
- Procedural memory keeps a learned step as `{kind: "api_operation", method, action: <path template>}` only: no example values, headers, session ref names, operation id or response shape reach memory or its embeddings.
- The Skills screen shows each command's type (gets data / changes data through the site's API, with the page as a fallback for hybrid), check status (checked with a new input / last check failed / not checked yet) and transport (asks the site directly / from your signed-in browser / through the site's page), using the remembered tier when there is one.

## Bridge messages

The paired extension only (`API_EXTENSION_REQUIRED` for anyone else). One message per call; nothing is stored in the Bridge.

```
→ {"type":"api_request","id":"…","action":"status|propose|learn|verify|call|page_request|page_answer|page_trigger|page_run","payload":{…},"approved":false}
← {"type":"api_result","id":"…","ok":true,"data":{…}}
← {"type":"api_result","id":"…","ok":false,"error":{"code":"API_…","message":"…","candidates":[…]}}
```

`approved: true` is sent only after the person approved the write it carries. `/status` reports `api_engine_enabled`.

## Compatibility

- Existing recipes (`input`, `submit`, `api_fetch`) and Skills load and run unchanged.
- Downgrading is not supported for a library that holds API Recipe v2 recipes: an older extension's runner does not know `api_operation` and would treat it like the end of a form. Delete those recipes (or their Skills) before installing an older build.
- Without the helper app, an API Recipe v2 recipe returns `unavailable` at every tier (the Bridge builds and judges tier 2 and 3 requests too); form recipes still run.
