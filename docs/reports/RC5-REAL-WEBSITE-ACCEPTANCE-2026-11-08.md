# Native API Engine RC5 — real-website acceptance, 2026-11-08

**Release decision: NO MERGE.** Four of the eight real-site scenarios passed, two were partial, one was blocked by the absence of an authenticated account in the disposable Chrome profile, and one did not encounter the required real-world drift. This is acceptance evidence for the local `codex/rc5-integration` candidate (base `1d47512`, plus the GraphQL auto-selection correction), not a claim about a released build.

Environment: Windows 11; Chrome for Testing in isolated, disposable profiles; the built BrowserHarness extension and locally running Bridge. Public websites were visited directly. GitHub Actions were not used. No personal sign-in credentials were copied into the profiles. Guest-cart tests used a disposable cart, never checked out, and cleared it after the test.

| Scenario | Result | Real-site evidence and limit |
| --- | --- | --- |
| 1. Public search | **PASS** | crates.io: two terms learned; a different term executed and agreed with the visible site. Learned operation was verified. |
| 2. Signed-in read | **BLOCKED** | An isolated profile had no legitimately signed-in account. Tier 2 against a real authenticated endpoint, signing out, and absence of exported live credentials cannot be claimed. The local sign-in/privacy fixture remains green. |
| 3. GraphQL read | **PASS** | Coursera search: automatic selection chose GraphQL `#Search` as a read, verified the operation and executed after a page reload via tier 3. A higher-scoring mutation-shaped competitor was added to a regression test in both capture orders. |
| 4. Protected site | **PASS** | npmjs.com search was identified as `API_LEARN_BLOCKED` with no repeating challenge loop (roughly 33 seconds in the live run). |
| 5. Watch Me search and write | **PASS** | Two real crates.io searches recorded with the actual side-panel **Record workflow** and **Finish recording** controls; toolbar `REC`, in-page banner, panel indicator, saved workflows, and verified API learning observed. The panel test passed on consecutive runs after waiting for asynchronous workflow saving. On sabpuja.com, a real Akshat Rice guest-cart demonstration was captured. Learning sent no write. Running required explicit approval; Cancel left the cart empty; Approve sent one addition and reported **sent, not confirmed**; the cart was cleared again and observed at zero. No order or purchase. |
| 6. Drift repair | **NOT TRIGGERED** | No genuine API drift occurred during the live window. The local repair fixture does not substitute for a real drift-and-repair acceptance. |
| 7. API on another host | **PARTIAL** | hn.algolia.com learned and ran a verified tier-3 read against the page's Algolia API host. The exported contract did not contain a tracking endpoint. The real-site approval card naming both website and API destinations for a cross-host **write** was not exercised; a unit regression now verifies the approval text contains both hosts. |
| 8. Profile isolation | **PARTIAL** | Two disposable Chrome profiles were used. A marker cookie and learned Skill remained in A; B had neither and could not run A's Skill. Authenticated session isolation still requires an actual signed-in test. |

The live side-panel recordings initially exhibited asynchronous save/capture timing: a second recording could not always be learned immediately when Finish was clicked. Waiting until the panel reported the saved workflow resolved the observed failures; a second end-to-end pass succeeded. This does not prove the timing is immune to all races.

## Local regression gate

`npm run gate:api-engine` passed on 2026-11-08: vendored upstream check, **151 Bridge tests**, **830 extension tests**, extension typecheck and build, Bridge bundle, MV3 validation, **48/48** Chromium API-engine checks, **23/23** Chromium approval checks, and **26/26** Chromium Watch Me checks. After the cross-host approval regression was added, a complete extension retest passed **831/831**, including **7/7** RC5 tests.

## Merge blockers and next acceptance

Run the signed-in read/sign-out case with a legitimate session explicitly opened in the isolated test browser; confirm no credentials enter the exported Skill. Validate a real cross-host **write** approval card showing both names without sending an unintended request. Confirm authenticated isolation in profile B. Perform real drift repair only when an actual drift case exists, or explicitly scope that item out of the release gate. Keep R5-7 (pre-run write status), R5-8 (write inference without explicit `side_effect`), and R5-9 (empty-list rendering) on the known-issues list.

The source scripts used for reproducible live checks are `scripts/rc5-real-site-acceptance.mjs` and `scripts/rc5-panel-watch-real.mjs`. They are manual tests against external sites and must never run automatically in CI. Re-run the cart portion only with permission to alter and clear the disposable guest cart.
