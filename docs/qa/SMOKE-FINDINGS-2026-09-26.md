# BrowserCrew MVP Smoke Findings — 2026-09-26

## Environment
- Chrome unpacked extension build from BrowserCrew v0.1 development artifact.
- Provider: Groq through the OpenAI-compatible adapter.
- Base URL used successfully: `https://api.groq.com/openai/v1`.
- Model tested: `openai/gpt-oss-120b`.

## Confirmed pass
### Current-page summary
**Result:** PASS

The user connected Groq successfully and BrowserCrew completed a page-summary task.

This confirms the following path works in real Chrome:
extension → local provider config → OpenAI-compatible Groq endpoint → page observation → model response → chat result.

## Confirmed failure
### Google Docs writing
**Result:** FAIL on the first build tested.

Observed behavior:
- task remained visibly at **Reading the current page**;
- no text was written into the Google Doc.

Root cause identified:
- BrowserCrew v0.1 initially supported normal input/textarea DOM editing only;
- Google Docs uses canvas-based document rendering and a hidden text-event target, so ordinary DOM typing is insufficient.

Remediation in progress:
1. support generic `contenteditable` editors;
2. expose Google Docs' hidden text-event editor as a semantic **Document content** target;
3. dispatch text through the Docs text-event target without adding the broad Chrome debugger permission;
4. if this remains unreliable, evaluate a stronger trusted-input fallback separately.

## UX finding
### Stop control visibility
The first tested build placed Pause/Stop above the composer only while a run was active, which was too easy to miss.

Remediation:
- add an always-visible red Stop icon in the sticky header while a task is running;
- Stop aborts the active provider/model fetch rather than merely waiting for that request to finish;
- the existing lower Pause/Stop controls remain available.

## Next verification
Install the next CI-green artifact and rerun:
1. Google Docs: click into the document, ask BrowserCrew to write a short sentence, verify insertion;
2. while the model is deciding, press the header Stop button and verify the request aborts immediately;
3. verify ordinary page summary still passes with Groq.

Do not mark Google Docs writing passed until this is confirmed in real Chrome.


## Additional runtime finding
### Content script unavailable after extension reload
Observed error:
`BrowserCrew cannot control this page. Chrome internal pages and some protected pages are not supported.`

Likely cause on a normal Google Docs tab:
- the extension was reloaded while the tab was already open;
- Chrome does not retroactively run manifest content scripts in an already-loaded page after an unpacked-extension reload.

Remediation:
- add the `scripting` permission;
- when a message to a normal HTTP(S) tab fails, BrowserCrew attempts to inject `assets/content.js` and retries automatically;
- true protected browser pages return `UNSUPPORTED_PAGE` instead of the misleading generic content-script message;
- if injection still fails, the UI instructs the user to reload that tab once.

This keeps normal-page recovery automatic while preserving an explicit protected-page boundary.


## Mixed Google Docs / Groq retest
User-reported sequence:
- `write 30 sec video script about ai and its future` → **Model did not return a BrowserCrew action**
- `Write "BrowserCrew Google Docs test" at the current cursor position.` → parse failure
- same Docs command → **PASS**, text inserted successfully
- same Docs command again → parse failure while activity stayed at **Reading the current page**

Interpretation:
- Google Docs editor control is now proven viable by at least one real insertion.
- The dominant intermittent failure is the model action contract, not the editor transport.
- Direct chat/final-answer tasks were affected by the same malformed model response issue.

Remediation shipped in candidate build:
- detect Groq through the OpenAI-compatible base URL;
- request `response_format: {"type":"json_object"}`;
- set `include_reasoning: false`;
- use low reasoning effort for Groq GPT-OSS models to keep the browser-control loop responsive;
- parse balanced JSON objects defensively;
- accept a small set of equivalent action/message shapes;
- perform one bounded repair retry when the first response is not a valid BrowserCrew action.

Latest parser-fix commit: `c507d8f05916e8e016add31a0cd69aa23735b55b`.
GitHub Actions run: `36250049822` — success.
Artifact ID: `10908409160`.

Next verification:
1. direct chat: ask for a 30-second AI-future video script;
2. Google Docs: run the same insertion command at least 5 times;
3. record any remaining parser failure rate rather than treating one pass as sufficient.


## NVIDIA runtime stall finding
User-reported behavior on the first NVIDIA/model-discovery build:
- direct prompts such as `write 30 sec video script about ai and its future` and `hi whats you name` were manually stopped after hanging;
- Google Docs write task remained at **Reading the current page**.

Interpretation:
- every prompt was unnecessarily observing the current Google Doc before the model decided whether browser state was needed;
- NVIDIA chat requests were not bounded by a client timeout;
- NVIDIA reasoning-capable models could spend a large default output/reasoning budget before returning the BrowserCrew JSON action;
- abort-like provider/network failures were displayed as `Stopped.`, conflating user cancellation with provider interruption.

Remediation:
1. BrowserCrew now asks the model to route the task before observing the page.
2. Conversational/writing tasks can return `kind=final` without touching the browser.
3. Browser tasks explicitly request `observe_page` when page state is needed.
4. NVIDIA requests use bounded `max_tokens`, JSON Object Mode, and reasoning-disabled template kwargs for common reasoning model families.
5. Model calls time out after 30 seconds instead of hanging indefinitely.
6. NVIDIA HTTP 400 compatibility failures retry once with plain OpenAI-compatible chat fields.
7. Empty model responses now produce an actionable error suggesting a chat/instruct model.
8. Only an explicit user Stop is rendered as `Stopped.`; other aborts/errors surface separately.

Latest runtime-fix commit: `8663c5b75aee631651bf9f3e4cb3b03e2c65fe02`.
GitHub Actions run: `36254678941` — success.
Artifact ID: `10909394225`.
