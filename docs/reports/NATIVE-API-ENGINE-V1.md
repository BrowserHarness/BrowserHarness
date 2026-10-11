# Native API Engine v1: final report

Date: 2026-10-10. Scope: the six-PR plan from the master implementation brief ("Native API Learning, Hybrid Execution & Self-Healing Engine").

**Status:** v1 is built and verified against local fixtures in real Chromium. Release candidate 1 (`4e79b41`) went through real-site acceptance on 2026-10-10 and was **rejected** (2 of 8 scenarios passed). Release candidate 2 (`1f8eee4`) went through real-site acceptance on 2026-10-11 and was **rejected** (NO MERGE: 1 pass, 3 partial, 4 fail), though it fixed F4 to F9. Release candidate 3 (`58b154c`) went through real-site acceptance on 2026-10-11 and was **rejected** (NO MERGE: 2 pass, 2 partial, 4 fail). Release candidate 4 fixes the defects found there, each reproduced first with a failing test, and adds an automated acceptance run through the real side panel. RC4 has **not** been through real-site acceptance; every RC4 result below is from local fixtures (Node tests and real Chromium against local stand-in sites).

## RC4: fixes from the real-site acceptance of RC3

RC3 acceptance (Windows 11, Chrome for Testing, the person's own accounts; full results and 57 sanitized diagnostics in `acceptance-58b154c/` on the test PC) passed crates.io search and profile isolation, kept every credential out of the Skills and left Hermes untouched. It found the defects below. Each was reproduced first with a failing test (`apps/bridge/test/api-engine-rc4.test.mjs`, `apps/extension/src/runtime/api-engine-rc4.test.ts`); the failing output before each fix is kept with the release notes.

| # | What acceptance saw | Cause | Fix |
|---|---|---|---|
| P0 | Every signed-in Shopify read, GBIF and Algolia: tier 3 `endpoint_drift` | Tier 3 built the request expected for the inputs with an empty session that lacked `values`; any operation holding a non-cookie session value threw there and never matched | The expected request is built with an empty session of the right shape; a slot that mixes an input with a session value is matched on the input |
| P0 | After "Always allow on this site", `/sabpuja-add-to-cart` ran without asking | The site grant (and automatic mode) answered every question on the site, writes included, and a write's question offered the grant | A learned write and a Site Skill submit ask before every run; no grant or automatic mode answers them; their question offers no "Always allow" |
| P0 | `/sabpuja-add-to-cart` "filled the form without sending it" | Two causes. The side panel read the command's answer as a form's (an API write's answer has no `submitted`), and the page form of the same Skill could take the plain name | A learned write's answer says it sent the request and that the change is not confirmed; the learned operation takes the plain name and the form keeps `-form` |
| P0 (found by the new automated run) | An approved add to cart answered 200 but the person's cart stayed empty | Tier 1 sent the write as plain HTTP without the browser's cart cookie: Shopify put the item in a new cart | A write never runs at tier 1; it starts at tier 2, from a page of the site with the browser's own cookies |
| P1 | The prompt said "no item of its own" instead of naming Akshat (Rice) | Shopify sends Add to cart as `multipart/form-data`, which the target reader did not parse | Multipart fields are read (form bookkeeping skipped), and the learned answer's own name for the item is kept as `target.label` |
| P1 | Cancel on the approval prompt did nothing | The panel never took the question away after an answer | The first answer, Cancel or Approve, closes the question |
| P1 | A 429 during learning was not reported as rate limited | Only the first example's run was checked for obstacles | Both runs are checked: `API_LEARN_RATE_LIMITED` |
| Found by the new automated run | A Shopify product form was listed as `/site-object-htmlselectelement` | The page reader used `form.id`, which the variant select named `id` shadows | Form id, name, action and method are read as attributes |

**Automated acceptance (`npm run smoke:api-acceptance`, part of `gate:api-engine`):** real Chromium with the built extension and Bridge, driving the person's real side panel. It learns a Shopify-like product page (multipart Add to cart behind a cart cookie) from a Watch Me demonstration, checks that learning sends nothing and names Akshat (Rice), runs `/local-add-to-cart` from the chat box with a saved "Always allow" grant, Cancels (nothing sent), Approves (sent once, into the person's own cart, read back from the site), checks automatic mode still asks, and that promotion is refused; then learns and runs a signed-in search whose page sends a storage token and a one-time value a moment after it loads (tier 3). Run against RC3's build it fails as the real run did ("Filled the form on … without sending it", no question asked); against RC4 it passes 23/23.

**Not addressed in RC4 (from the RC3 report; need the sanitized diagnostics to reproduce):** the Shopify customer token at tiers 1 and 2 and a session reference name containing the customer id; Coursera (`IR_gbd`, the Search pick refused as a private value, the auto-pick); "signed in" detected on public sites; GBIF's public dataset key treated as a session value; the repair message wording.

## RC3 (rejected): fixes from the real-site acceptance of RC2


RC2 acceptance (Windows 11, Chrome for Testing, the person's own accounts; full results in `ACCEPTANCE-RESULTS-1f8eee4.md` on the test PC) passed crates.io search and confirmed F4 to F9 fixed, Hermes untouched (`--no-agents`), no credential in any Skill, the visitor-id refusal, candidate isolation and the repair cooldown. It found the defects below. Each was reproduced first with a failing test (`apps/bridge/test/api-engine-rc3.test.mjs`, and extension tests named after them).

| # | What acceptance saw | Cause | Fix |
|---|---|---|---|
| N1 (F3) | YouTube history (HTML) and an npm run answered `ok`, signed in and signed out | Learning refused a whole page, but a run judged it with upstream's classifier, which accepts any HTML for a page recipe with no selector | A read whose answer is a whole page is never `ok` at any tier: a sign-in page (sign-in form, login wording, a login address) is `auth`, anything else `unavailable` with "teach it again" |
| N2 (F1) | Shopify add-to-cart refused as keeping a "session value" | Shopify keeps the product page's address in page storage; the referer and trigger hold it, so the secret scan refused the write | Page storage is filtered before learning: the site's domain, an address on the capture's hosts (with no token in it), a visited path, a GraphQL document or operation name are public. Tokens, visitor ids and random-looking values stay refused (tested) |
| F1 | Coursera still refused (`IR_gbd`) | The same public values in page storage | The same filter |
| N3 | `pick_request` picked Profile but learned payment methods or Orders | All of Shopify's customer GraphQL operations share one address; the string form ignored `operationName`; listed ids were capture positions, so they named another request on the next run | Requests are named `"POST https://host/path #Operation"` in listings and `pick_request`; ids are derived from that name and its occurrence, the same on every run; an Apollo-style cached query in storage is never a session value |
| N4 | GBIF at tier 3: false `endpoint_drift` | The extension stopped at the first matching request (the page's default query without `q`) | The Bridge answers `awaiting_request` when the page's matching requests do not carry the inputs yet; the extension keeps watching (up to 15 s) for the next one |
| N5 | HN Algolia at tier 3: false drift | Algolia moves a page between `APPID-dsn.algolia.net` and `APPID-N.algolianet.com` | Tier 3 recognises sibling hosts of one app id (letters and digits, a `-dsn`/`-N` suffix, the same domain stem). Only tier 3 uses it, to recognise the page's own request; nothing is sent to a sibling |
| N6 | YouTube Watch Me search learned the suggestions request | The suggestions request carries the input too and came last | Among requests carrying every input, a suggestions/autocomplete request and a whole page lose to a data request |
| N7 | A learn that did not verify forced a new recording | Watch Me captures were dropped after any learn | Captures stay their 15 minutes, so another `pick_request` needs no new recording |
| N8, N9 | A 429, a bot check or a signed-out page during learning said only "learn failed" | Learning never classified what it met | `API_LEARN_RATE_LIMITED`, `API_LEARN_BLOCKED` and `API_LEARN_AUTH`, with `class` `rate_limited`, `blocked` and `auth` |
| N10 | Shopify's token sign-in recorded `learned_logged_in: false` | Only cookies counted as a sign-in | An authorization header or credential-named value from storage counts too |
| Low | Approval said "acts on 0 92313813308" | The target named the last path step, an array index | Each target field records its name (`id`) |
| Low | Repair of a no-input read asked for examples | Repair needed two taught examples | A no-input read is repaired from two plain page runs with its own request (and GraphQL operation) as the pick; a read with inputs names the ones it needs |
| Low | Empty candidate list said "choose one" | | Says the page made no data requests while watched |
| Low | A failed run named only the last tier | | The error lists every tier tried with its class and reason |

Not changed: the visitor-id refusal, approval before every write, no automatic resend, `sent: true` / `verification: "unverified"`, revision isolation and the repair cooldown.

**RC3 automated results (local fixtures only):** `gate:api-engine` passed: Bridge 136/136, extension 796/796, typecheck, builds, MV3 contract, real-Chromium API engine 48/48. Smoke suites: sites 21/21, bridge 53/53, memory 31/31, helpers 11/11, learning 24/24, e2e 13/13, agent 13/13, features 18/18. Installer and Hermes isolation 8/8.

**Still to run on real sites:** scenarios 2, 3, 5 (the whole write path: approval prompt naming the item, refusal on another item, one approved send, unverified blocks promotion), 7 and 8. Not covered by any RC3 change: Meetup has no results API (only autocomplete, correctly left unverified), and the tier-3 independent-header check still needs a suitable real site.

## RC2: fixes from the real-site acceptance of RC1

RC1 acceptance (Windows 11, Chrome for Testing, the person's own accounts) found nine defects (F1 to F9). Each was reproduced against the local fixture shop with a failing test before it was fixed. The fixes are one new stacked PR on top of #52.

| # | What acceptance saw | Cause | Fix | Regression test |
|---|---|---|---|---|
| F1 | Coursera and Meetup refused: "header:referer holds the live cookie IR_gbd / _li_dcdm_c". | Tracking cookies whose whole value is the site's own domain; every address on the site "contains" them. | Before learning, a cookie whose value is a host of the capture (or a parent domain of one) is not treated as a credential. Real session cookies are still refused or referenced. | `api-engine-acceptance.test.mjs` F1 |
| F2 | GBIF: `endpoint_drift` at learn, run and repair. YouTube Watch Me learned the autocomplete request. | Tier 3 required a header that echoes the page address to match character for character. When requests tied, the first was learned. | Tier 3 compares the input slots outside headers when there are any. When requests carry the inputs equally, the page's last one (the one the action produced) is learned, with a warning. | F2 header echo; F2 tie |
| F3 | AniList and YouTube history learned the HTML document, counted it as 1 item and marked it verified. Signed out it still answered `ok`. | A raw page was judged like data. | A whole page answer (HTML with no extraction recipe) never passes `learned_examples` or the live check. When a page and a data request carry the inputs equally, the data request is learned. | F3 (two tests) |
| F4 | Learns taking 33 to 39 s returned "Bridge command timed out" and the answer was lost. | One 30 s limit for every command. | Learning, repair, verify, Site Skill runs and Site Command runs wait up to 5 minutes, in the Bridge, the MCP client and the CLI. Ordinary commands keep 30 s. | `core.test.mjs` "a long learn gets its answer" |
| F5 | AniList `learned_logged_in: true` while signed out. | Laravel's `laravel_session` (set for every visitor) matched the sign-in cookie pattern. | Framework sessions set for anonymous visitors (`laravel_session`, `ci_session`, `PHPSESSID`, `JSESSIONID`, `ASP.NET_SessionId`, `connect.sid`) are not a sign-in. This is a heuristic list. | F5 |
| F6 | A signed-in list with no input (Shopify orders) and a checkbox write (Watch later) could not be learned. | Learning required typed inputs. | A page with no `{input}`, or a Watch Me recording that typed nothing, is learned from the request picked with `pick_request` (F9). A no-input read verifies only when a live call answers with real data (structured, at least one item). A write stays unverified, is never sent to check it, and asks before every run. | F6 (three tests); e2e "a page with no input lists its requests", "the picked no-input read verifies live" |
| F7 | The run sheet said `entry_url`; Site Command answers had no tier; object `parameters` sent through raw `/command` were ignored. | Doc error; the answer dropped `run.output.api`; fields beside `args` in a `/command` body were dropped silently. | The run sheet says `page_url`. Site Command answers include `tier`, `class` and `item_count`. A `/command` body with no `args` takes the tool's fields from beside `session` and `action`; fields both beside and inside `args` are an error, never silently dropped. | `site-commands.test.ts`; `core.test.mjs` "fields beside args" |
| F8 | An install into a redirected home still changed the real `%LOCALAPPDATA%\hermes\config.yaml` and its skill file. | `%LOCALAPPDATA%` (and `%APPDATA%`) were used even when outside the chosen home. An existing registration was repointed at the new Bridge. | Profile folders are used only when they are inside the chosen home. An agent already registered to another BrowserHarness Bridge is kept, with its skill file, unless `--replace-agents` is given. Every change also keeps `<file>.browserharness-previous`. | `install.test.mjs` "a second install in another home never touches the real Hermes" |
| F9 | The refusal said "add --from <id> --pick-request <n>", which `site_skill learn_api` does not have. | Upstream's command-line hint passed through. | `site_skill learn_api` takes `pick_request`: `"METHOD https://host/path"` (the same on every run) or a request id in the capture. Every learning refusal lists the captured requests as `data.candidates`, with method, origin, path, status, content type, the input names each carries and a score. Values are never included. Upstream's command-line hints are rewritten. | F9 |

**The visitor-id protection is unchanged.** Acceptance saw YouTube's `get_panel` refused because `x-goog-visitor-id` carries the visitor cookie. That refusal still fails closed, including when that request is picked by hand (F9 test, "choosing the panel request is still refused"). Picking only lets a person choose a different request. It never makes a refused one learnable.

Hermes on the acceptance PC was restored by hand from its backup after acceptance, not by rerunning an installer. RC2's installer no longer touches it in that setup.

### RC2 final: independent source review

A source review of RC2 (`95b35db`) found two more problems. Both were reproduced first (Bridge tests failed; the real-Chromium e2e then found a third path, below), then fixed.

| Problem | Fix | Regression test |
|---|---|---|
| Tier 3 set aside every header input whenever the path, query or body carried one, so a request whose body matched but whose independent header input (say a region) differed was accepted. | Only headers that mirror the page's address are set aside: `referer`, `origin`, or a header whose learned template is itself an address (GBIF's `x-gbif-site-url`). Every other input slot must hold exactly the value given. Every param must be proven by at least one slot; a param that only a page-address header carries must be named in that address (as a whole query value or path segment), else the request is rejected. | `api-engine-acceptance.test.mjs`: independent header differs (rejected), both match (accepted), two similar requests (the right one answers), page-address header differs (accepted, GBIF kept), wrong GraphQL variables (rejected), echo-only input names other values (rejected) |
| A checkbox write learned with no input (Watch later) kept the video id from the demonstration, and nothing said so: run while viewing another video, it would act on the first one. | A learned write records its `target`. **Fixed**: no inputs; the identifying fields of its request (for example `addedVideoId jNQXAC9IVRw`) are listed in the Skill's details, the Site Command (`acts_on`) and the approval prompt, which says it acts on that item, not on the page being viewed. A fixed write given any value (another video) is refused before sending. **Parameter**: the item is an input (learned from an example), required on every run, and only the value given is sent; the demonstrated value is not kept. A write with no inputs and no recorded target (learned before RC2) is refused before sending: teach it again. | Bridge: fixed write refuses video B and sends A as learned; untargeted write refused; dynamic write sends only B. Extension: approval text; Site Command `acts_on`; runner refuses an unmapped value before calling. e2e: tick Watch later on video A, learn it, open video B: the prompt names A, an approved run with video B sends nothing, an approved run as learned sends A once and says sent, unverified |

The e2e caught one more path the Bridge tests could not: the extension mapped run values to the contract's params and silently dropped any other, so an approved run "for video B" of the fixed write sent video A. A write now refuses any value it cannot take, before calling the helper app.

Unchanged: the session-value refusal (YouTube's visitor id), approval before every write, no automatic resend, and `sent: true` with `verification: "unverified"` for a write the site accepted.

Known limit: repair of a no-input operation needs the request picked again (`learn_api` with `pick_request`), because repair has no input to find the moved request by.

## Fixes after the independent review

An independent source review of the stack (2026-10-10) found six problems. Each was first reproduced with a failing test, then fixed on the PR that introduced it and merged up the stack:

| PR | Problem | Fix | Regression test |
|---|---|---|---|
| #48 | The Site Skill's website origin was set to the API host, so a page on `www.example.com` calling `api.example.com` clashed with that site's Skill. | `site.origin` is the website (the learning page); `contract.origin` stays the API destination; the approval prompt names both when they differ. | `api-recipe.test.ts`: "keeps the visible website and the API host apart" |
| #48 | Learning read cookies for up to 20 origins seen on the page, including trackers. | Only the page's own origin and same-site origins (`api.shop.example` for `www.shop.example`). | `api-capture.test.ts`: cookie origins exclude analytics, ads and other sites |
| #49 | Tier 3 answered with the last matching request, even one sent with other inputs. | The Bridge receives the inputs and accepts only a request whose every input slot holds them; otherwise `endpoint_drift`, with no data. | `api-engine-transport.test.mjs`: ignored input, two same-path requests, missing inputs, unseen-input check over tier 3 fails |
| #50 | Two concurrent repairs could both pass the cooldown check. | A repair is reserved (in memory and in the ledger, as `running`) before learning starts. | `api-repair.test.ts`: concurrent repairs learn once; an expired reservation is not a block |
| #51 | A Watch Me write could keep typed values when unlabelled, or with an empty or partial `private_params`. | The Bridge classifies the request before saving; anything not proven a read gets every input made private; a final sweep refuses to save (`API_LEARN_PRIVATE_VALUE`) if a typed value remains in any encoding. | `api-engine-learning.test.mjs`: no label, empty, partial and declared write; `api-learning.test.ts` |
| #52 | An API write the site answered 2xx was recorded as passed, with no read-back. | It is recorded as `unverified` (which blocks promotion) and returns `sent: true`, `verification: "unverified"` and a `next_action` to check the site and not resend. | `api-recipe.test.ts` (2xx, no state change); `api-engine-hardening.test.mjs` (fixture shop accepts and changes nothing) |
| #52 | The early-wait matcher for tier 3 escaped `*`, so wildcard operations missed it. | Host and path compared segment by segment, `*` matching one segment, as the Bridge's matcher does. | `api-capture.test.ts`: wildcard segments |

### Second review: write recording

A second review of the write-recording change found two gaps, both reproduced first in real Chromium (the e2e failed 37/39 on the old code) and then fixed in #52:

| Problem | Fix | Regression test |
|---|---|---|
| A learned write run as a named site command lost `sent`, `verification` and `next_action`, so it read as a plain HTTP 200. | Site commands keep them; the CLI prints that the change is not verified; the MCP tool descriptions, the Bridge's agent skill text and the agent prompt say a sent write is not a completed task and must not be resent. | e2e: a write approved in the person's real side panel, run by name, against a 200-without-change fixture; `site-commands.test.ts`; `mcp.test.mjs` |
| Promotion looked only at the revision's latest execution, so a read that passed (and its health check) after an unverified write made the revision promotable. | Promotion is also checked per recipe: while any recipe's latest execution is `unverified`, the revision cannot be promoted. Only API writes are recorded that way, so UI and read-only Skills are unchanged. | e2e: unverified write, then a passing read and health check, then promote is refused; `site-skill-store.test.ts` |

The e2e can now stand in for the person approving: it opens the real side panel with a click and sends the approved run from there. A page open in a tab still cannot claim approval (also checked).

## What shipped

| PR | Scope |
|---|---|
| [#47](https://github.com/BrowserHarness/BrowserHarness/pull/47) | Audit, [ADR 0001](../architecture/API-ENGINE-ADR.md), the vendored upstream engine and its MCP adapter |
| [#48](https://github.com/BrowserHarness/BrowserHarness/pull/48) | [API Recipe v2](../protocols/API-RECIPE-V2.md) (`api_operation` step, contract v2); `site_skill learn_api` from two examples with a live check on an unseen input |
| [#49](https://github.com/BrowserHarness/BrowserHarness/pull/49) | Hybrid execution: tier 1 (Bridge HTTP), tier 2 (in-page request with the site's cookies), tier 3 (the site's own page); a dispatcher with a remembered tier |
| [#50](https://github.com/BrowserHarness/BrowserHarness/pull/50) | Session references, failure classes, health checks, and bounded repair into candidate revisions |
| [#51](https://github.com/BrowserHarness/BrowserHarness/pull/51) | Learning from Watch Me (the only path for writes), read-only helpers, planning preference, sanitized procedural memory, Skills screen details |
| [#52](https://github.com/BrowserHarness/BrowserHarness/pull/52) | Hardening (failure fixtures, two speed fixes), regression gate, benchmark, capability manifest, this report, release zips |

How it fits together:

1. A Site Skill recipe may contain an `api_operation` step. It sits in the existing registry, with the existing revision, evaluation and promotion gate. There is one browser runtime and one Skill registry.
2. Learning happens in one of two ways:
   - The extension runs the page twice with two inputs; the Bridge learns the request with upstream's deterministic learner (no model); the extension then calls the operation live with a third input.
   - The extension learns from one or two Watch Me demonstrations.
3. Running tries tiers cheapest first, starting with the tier that last worked and never going below the operation's minimum tier.
4. Every answer is fresh (`fresh: true`, `fetched_at`) and classified into one of these classes:
   - ok
   - input
   - auth
   - rate_limited
   - blocked
   - network
   - schema_drift
   - endpoint_drift
   - ambiguous_write
   - approval_required
   - unavailable
5. Writes:
   - need approval on every run;
   - are never resent after they reach the site;
   - are never learned by running the page;
   - are recorded as sent and unverified when the site accepts them, never as passed.
6. Drift leads to `site_skill repair`, which re-learns the operation as a new candidate revision. Repair:
   - is limited to reads;
   - has a cap and a cooldown, and is reserved before it starts so two repairs cannot run at once;
   - never changes the active revision.

## Verified vs experimental

**Verified** means it passes automated tests and the local real-Chromium fixture test. Every item below is verified only against fixtures:

- Learning:
  - a GET JSON API;
  - a persisted-query GraphQL POST;
  - a signed-in read (cookie session);
  - a request carrying a per-load nonce, which is learned as page-only (`min_tier` 3).
- Live checks: the unseen-input check rejects a recipe whose input never reaches the request.
- The three tiers and the dispatcher:
  - fall-through rules;
  - the remembered tier;
  - writes not being resent;
  - a thrown transport during a write treated as ambiguous.
- Failure classes against fixtures: rate limit (429), bot wall (challenge page), site down, endpoint moved (404), field renamed, and a write whose connection dropped after the server took it.
- Repair:
  - learns the moved endpoint again into a candidate revision;
  - leaves the active revision unchanged until promotion;
  - refuses a second repair during the cooldown.
- Watch Me: two search demonstrations learned and verified live. A demonstrated write is learned without being re-sent, keeps no typed value however it is labelled, and asks before running.
- Tier 3 answers only with the page's request that carried the given inputs.
- An approved API write is recorded as sent and unverified, never as passed, through `site_skill run` and named site commands alike, and a revision holding one cannot be promoted. Approval for it comes only from the person's side panel; a page open in a tab cannot claim it (both checked in the e2e).
- A website that calls an API on another host keeps its own origin as the Site Skill's site, and learning reads only that site's cookies.
- Helpers: may run a learned read and are refused a learned write (`SUBAGENT_SCOPE_DENIED`).
- Secrets:
  - cookie and storage values never appear in the Skill library (checked in the e2e);
  - the secret scan fails closed;
  - private inputs are removed from the contract;
  - procedural memory keeps only the method and path template.

**Experimental or unproven:**

- **Behaviour on real sites.** None has been tested. Real sites add CSRF tokens, request signing, consent walls, aggressive bot protection, GraphQL APIs that rotate query ids, and region and account differences. The fixtures model some of these, but not all.
- **Tier 2 sends from the site's `/robots.txt` page, or its home page if that one leaves the site.** It never sends from a page that ended up on another origin, such as a redirect, a challenge host or an error page; it answers `unavailable` with nothing sent, and reads move on to tier 3. Unit tests cover this. It is not yet measured on a real site.
- **Watch Me capture covers only the tab where recording started.** Requests in tabs opened later are not captured. If the service worker restarts during a recording, the capture is lost and the person has to record again. A search done entirely in the page, with no address change, needs `page_url` before tier 3 can replay it.
- **Learning writes from one demonstration** cannot tell nonces from constants, and the learner warns about this. Such writes stay `unverified` by design.
- **Deciding whether an operation is a write** uses the method, path words and GraphQL mutation detection, but it is still a heuristic. A person can declare `side_effect`. Anything not proven to be a read asks first.

## Upstream components used

The upstream is [goodnight000/api-anything](https://github.com/goodnight000/api-anything) at `fe5cca70fe145634e49a1c9ba1f3e8250b291bea` (MIT). Its compiled modules are vendored in `apps/bridge/vendor/api-anything` with LICENSE and `VENDORED.json`; `npm run vendor:check` verifies them. These parts are used:

| Upstream file | Used for |
|---|---|
| `learn.js` | Learner, candidate ranking, example checks, page capture shape |
| `http.js` | Request building, sending with per-site pacing, redirect policy, own-match |
| `classify.js` | Answer classification, login-path detection |
| `extract.js` | Bounded output |
| `heal.js` | URL templating, trigger filling |
| `secrets.js` | Secret scan |
| `codec.js` | Slot addressing, used to blank private inputs |

Not used:

- upstream's Playwright browser driver (stubbed; BrowserHarness's own Chrome extension does the browsing);
- its site registry;
- its standalone MCP server, which is replaced by the existing `site_skill` tool and Site Commands.

## Measured performance

**These are fixture numbers, not a speedup claim.** The "about 8 times" figure below compares one small, local fixture page with one local HTTP call. It is not a universal or real-site speedup, and it should not be quoted as one.

Measured on 2026-10-10 with `npm run bench:api-engine -- --runs 20` on the local fixture shop, in Chromium launched with `--headless=new` on a Linux cloud container. Raw measurements are in [api-engine-benchmark-2026-10-10.json](data/api-engine-benchmark-2026-10-10.json). Each figure is one Bridge `/command` round trip measured by the script, for one search with a correct answer (all 160 runs were correct).

| Mode | Back to back, median (p90) | Spaced 1.1 s, median (p90) |
|---|---|---|
| Browser: open results page in a background tab, read until results show, close | 419 ms (430) | 422 ms (433) |
| Tier 1: Bridge HTTP | 1000 ms (1004) | 52 ms (58) |
| Tier 2: request from a background tab of the site | 101 ms (116) | 118 ms (123) |
| Tier 3: the site's page loads and makes the request | 564 ms (579) | 575 ms (594) |

Learning one operation took 2656 ms (search), 2705 ms (signed-in orders) and 3122 ms (page-only), each including the two page runs and the live check.

How to read these numbers:

- **Back-to-back tier 1 is about 1 s by design.** The engine waits at least 1 s between calls to one site (upstream's politeness default). Spaced 1.1 s apart, tier 1 was about 8 times faster than driving this fixture page. That ratio belongs to this fixture only.
- **Tier 3 is slower than the plain browser path.** It loads the whole page, then waits for the operation's request and a short quiet before judging it. It is the fallback for requests only the page can make, not a speed path.
- **The fixture is local, small and fast.** On real sites, page loads cost far more and HTTP latency is real. These ratios are not a prediction for any real website.

The benchmark found two problems, which this PR fixes:

- Every Site Skill run that used no page was still followed by the 450 ms "let the page settle, then observe it" step. A tier 1 run took about 480 ms (HTTP itself about 3 ms) and now takes about 24 ms.
- Tier 3 waited for 1.2 s of network quiet after the page load. It now stops as soon as the operation's request has finished, plus 250 ms of quiet: about 1.75 s before, about 0.57 s after.

The before-fix run (3 runs per mode) is kept in [api-engine-benchmark-2026-10-10-before-fixes.json](data/api-engine-benchmark-2026-10-10-before-fixes.json).

After the review fixes the benchmark was run again with the same settings ([api-engine-benchmark-2026-10-10-after-review.json](data/api-engine-benchmark-2026-10-10-after-review.json)); all 160 runs were correct and the medians moved by a few milliseconds: browser 428 / 429 ms, tier 1 1001 / 53 ms, tier 2 101 / 120 ms, tier 3 573 / 586 ms (back to back / spaced). Checking tier 3's inputs costs nothing measurable here.

## Test results at release

All runs were local, on approved development infrastructure. No GitHub Actions workflow was created or used. These counts are from the RC2 head, after both reviews' fixes and the RC1 acceptance fixes. `npm run gate:api-engine` passed every step:

| Step | Result |
|---|---|
| vendor check | Passed |
| Bridge tests | 121/121 |
| Extension tests | 791/791 |
| Typecheck | Passed |
| Build | Passed |
| Bridge bundle | Passed |
| MV3 contract | Passed |
| `smoke:api-engine` (real Chromium, local fixture) | 48/48 |

Regression suites for the areas the review named, also in real Chromium against local fixtures:

| Suite | Covers | Result |
|---|---|---|
| `smoke:sites` | ordinary form Site Skills and site commands | 21/21 |
| `smoke:bridge` | Bridge commands and approval | 53/53 |
| `smoke:memory` | Memory v2 | 31/31 |
| `smoke:helpers` | helper (Task DAG worker) policy | 11/11 |
| `smoke:learning` | Watch Me and Skill learning | 24/24 |
| `smoke:e2e` | extension smoke | 13/13 |
| `smoke:agent` | agent loop | 13/13 |
| `smoke:features` | side panel features, including approval cards | 18/18 |

None of these is a real-website test.

## Limitations

- RC2 has had no real-website acceptance yet (see below). Fixture success is not real-world success.
- **Downgrade:** an older extension cannot run a library that holds API Recipe v2 recipes. Delete those recipes before installing an older build.
- **Helper app:** API recipes need the helper app (Bridge). Without it they answer `unavailable`, while form recipes keep working.
- **Watch Me capture lifetime:** captures live in memory for 15 minutes and are lost if the service worker restarts.
- **Repair scope:** repair re-learns from the operation's trigger page. A site that moved the feature to another page needs a person to teach it again.
- **Response shape:** the engine extracts JSON (and upstream's supported formats). Responses whose data is only rendered as HTML are left to the existing page tools.

## Real-browser acceptance (release-candidate milestone)

RC1 (`4e79b41`) was run through these eight scenarios on 2026-10-10: 1 and 4 passed, 6 and 8 partly passed, 2, 3, 5 and 7 failed (findings F1 to F9 above). RC2 needs the same run. It has not been done.

1. **A public search:** learn a public site's search with `learn_api` from two examples. Confirm it verifies, then run it with a new term and compare the result with the page.
2. **A signed-in read:** while signed in, learn a list such as orders or messages. Confirm:
   - the result answers through tier 2;
   - no cookie or token appears in the exported Skill;
   - signing out turns runs into `auth`.
3. **A GraphQL site:** learn one read and confirm it survives a page reload.
4. **A protected site:** on a site with bot protection, confirm the result is `blocked`, or that it falls through to tier 3, and that it never loops.
5. **Watch Me:**
   - demonstrate a search twice and learn it with `from_watch`;
   - demonstrate a harmless write (for example, adding an item to a wishlist, then removing it by hand). Confirm the learned write asks before it runs and is not sent while learning, that no typed value appears in the exported Skill, and that an approved run is reported as sent and unverified (then check the site by hand).
6. **Repair on a real site:** if a learned operation drifts during the acceptance window, run `site_skill repair`. Then compare and promote by hand.
7. **A site whose API is on another host** (for example `www.` calling `api.`): confirm the Skill is filed under the website, the approval names both hosts, and no tracker cookies were read.
8. **Multiple profiles:** confirm that a Skill learned in one Chrome profile does not carry that profile's session into another.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
