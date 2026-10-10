# Native API Engine v1: final report

Date: 2026-10-10. Scope: the six-PR plan from the master implementation brief ("Native API Learning, Hybrid Execution & Self-Healing Engine").

**Status:** v1 is built and verified against local fixtures in real Chromium. It has **not** been accepted on any real website. That test is the release-candidate acceptance milestone at the end of this report and has not been performed.

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
   - are never learned by running the page.
6. Drift leads to `site_skill repair`, which re-learns the operation as a new candidate revision. Repair:
   - is limited to reads;
   - has a cap and a cooldown;
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
- Watch Me: two search demonstrations learned and verified live. A demonstrated write is learned without being re-sent, keeps no typed value, and asks before running.
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

Measured on 2026-10-10 with `npm run bench:api-engine -- --runs 20` on the local fixture shop, in Chromium launched with `--headless=new` on a Linux cloud container. Raw measurements are in [api-engine-benchmark-2026-10-10.json](data/api-engine-benchmark-2026-10-10.json). Each figure is one Bridge `/command` round trip measured by the script, for one search with a correct answer (all 160 runs were correct).

| Mode | Back to back, median (p90) | Spaced 1.1 s, median (p90) |
|---|---|---|
| Browser: open results page in a background tab, read until results show, close | 419 ms (430) | 422 ms (433) |
| Tier 1: Bridge HTTP | 1000 ms (1004) | 52 ms (58) |
| Tier 2: request from a background tab of the site | 101 ms (116) | 118 ms (123) |
| Tier 3: the site's page loads and makes the request | 564 ms (579) | 575 ms (594) |

Learning one operation took 2656 ms (search), 2705 ms (signed-in orders) and 3122 ms (page-only), each including the two page runs and the live check.

How to read these numbers:

- **Back-to-back tier 1 is about 1 s by design.** The engine waits at least 1 s between calls to one site (upstream's politeness default). Spaced 1.1 s apart, tier 1 is about 8 times faster than driving the page here.
- **Tier 3 is slower than the plain browser path.** It loads the whole page, then waits for the operation's request and a short quiet before judging it. It is the fallback for requests only the page can make, not a speed path.
- **The fixture is local, small and fast.** On real sites, page loads cost far more and HTTP latency is real. These ratios are not a prediction for any real website.

The benchmark found two problems, which this PR fixes:

- Every Site Skill run that used no page was still followed by the 450 ms "let the page settle, then observe it" step. A tier 1 run took about 480 ms (HTTP itself about 3 ms) and now takes about 24 ms.
- Tier 3 waited for 1.2 s of network quiet after the page load. It now stops as soon as the operation's request has finished, plus 250 ms of quiet: about 1.75 s before, about 0.57 s after.

The before-fix run (3 runs per mode) is kept in [api-engine-benchmark-2026-10-10-before-fixes.json](data/api-engine-benchmark-2026-10-10-before-fixes.json).

## Test results at release

All runs were local, on approved development infrastructure. No GitHub Actions workflow was created or used. `npm run gate:api-engine` passed every step:

| Step | Result |
|---|---|
| vendor check | Passed |
| Bridge tests | 98/98 |
| Extension tests | 777/777 |
| Typecheck | Passed |
| Build | Passed |
| Bridge bundle | Passed |
| MV3 contract | Passed |
| `smoke:api-engine` (real Chromium, local fixture) | 35/35 |
| `smoke:sites` | 21/21 |
| `smoke:bridge` | 53/53 |

## Limitations

- No real-website acceptance yet (see below). Fixture success is not real-world success.
- **Downgrade:** an older extension cannot run a library that holds API Recipe v2 recipes. Delete those recipes before installing an older build.
- **Helper app:** API recipes need the helper app (Bridge). Without it they answer `unavailable`, while form recipes keep working.
- **Watch Me capture lifetime:** captures live in memory for 15 minutes and are lost if the service worker restarts.
- **Repair scope:** repair re-learns from the operation's trigger page. A site that moved the feature to another page needs a person to teach it again.
- **Response shape:** the engine extracts JSON (and upstream's supported formats). Responses whose data is only rendered as HTML are left to the existing page tools.

## Real-browser acceptance still needed (release-candidate milestone)

This should be done once, by a person, on the release-candidate build, in their own Chrome with their own accounts. None of it has been done.

1. **A public search:** learn a public site's search with `learn_api` from two examples. Confirm it verifies, then run it with a new term and compare the result with the page.
2. **A signed-in read:** while signed in, learn a list such as orders or messages. Confirm:
   - the result answers through tier 2;
   - no cookie or token appears in the exported Skill;
   - signing out turns runs into `auth`.
3. **A GraphQL site:** learn one read and confirm it survives a page reload.
4. **A protected site:** on a site with bot protection, confirm the result is `blocked`, or that it falls through to tier 3, and that it never loops.
5. **Watch Me:**
   - demonstrate a search twice and learn it with `from_watch`;
   - demonstrate a harmless write (for example, adding an item to a wishlist, then removing it by hand). Confirm the learned write asks before it runs and is not sent while learning.
6. **Repair on a real site:** if a learned operation drifts during the acceptance window, run `site_skill repair`. Then compare and promote by hand.
7. **Multiple profiles:** confirm that a Skill learned in one Chrome profile does not carry that profile's session into another.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
