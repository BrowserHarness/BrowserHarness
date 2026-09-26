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
