# BrowserCrew v0.1 Chrome Smoke-Test Gate

**Purpose:** verify the packaged MV3 extension in real Chrome before calling v0.1 release-ready.

## Latest packaged build evidence
- Main commit used for packaged-build CI: `cee5473dfc1d0632c9b162cf9f127620457feceb`
- GitHub Actions run: `36247547829`
- Result: success
- Passed: install, TypeScript, production build, output validation, ZIP packaging, artifact upload
- Artifact: `browsercrew-extension`
- Artifact ID: `10907589270`
- SHA-256 digest: `6e3c8e3f96f212469ae99f08fb37c90ba9d88bfff8ed721390eb61d728459432`

CI proves the package builds and contains a valid manifest plus expected entry points. It does **not** prove real Chrome behavior.

## Manual Chrome install
1. Download the `browsercrew-extension` artifact from the successful workflow run.
2. Extract the outer artifact ZIP; it contains the packaged BrowserCrew extension ZIP.
3. Extract the BrowserCrew extension ZIP.
4. Open `chrome://extensions`.
5. Enable Developer mode.
6. Choose **Load unpacked**.
7. Select the extracted extension folder containing `manifest.json`.
8. Pin/open BrowserCrew and confirm the side panel loads without console errors.

## Provider smoke tests
Run separately with:
- OpenAI
- Anthropic
- one OpenAI-compatible endpoint

Verify:
- connection settings persist locally;
- invalid credentials produce understandable errors;
- valid credentials can complete a read-only page task;
- API keys never appear in agent activity or browser console logs.

## Release scenarios

### 1. Current-page read
Prompt: **Summarize this page.**

Pass:
- BrowserCrew observes the active normal webpage;
- response matches visible page content;
- no mutation occurs.

### 2. Navigate
Prompt: **Open the pricing page on this site.**

Pass:
- agent uses semantic page elements or navigate;
- final URL is correct;
- BrowserCrew re-observes after navigation.

### 3. Site search
Prompt: **Search this site for <term>.**

Pass:
- input receives the text;
- search is triggered;
- results page/state is verified.

### 4. Form fill without submit
Prompt: **Fill these fields but do not submit.**

Pass:
- requested non-sensitive fields are filled;
- submit/send is not triggered;
- resulting values/state are observable.

### 5. Multi-tab single-agent comparison
Prompt: **Open the first three items in separate tabs and compare them.**

Pass:
- tabs are created;
- agent can switch/observe them;
- comparison cites information actually observed.

### 6. Consequential-action approval
Attempt a send/submit/purchase/delete/security-changing action.

Pass:
- action stops before execution;
- exact proposed action is shown in chat;
- Cancel prevents it;
- Approve permits only the requested action.

**Important:** current v0.1 approval detection is an early heuristic and must be hardened before public release, especially Enter-key/form-submit paths.

### 7. Pause / stop
During an active run:
- Pause freezes progression;
- Resume continues;
- Stop ends the run and cancels a pending approval.

### 8. Watch Me
1. Start Record.
2. Perform safe clicks/text entry on one page.
3. Finish recording.
4. Replay.

Pass:
- workflow saves locally;
- password fields are never recorded/replayed;
- replay resolves semantic locators;
- consequential recorded clicks still require approval.

Current v0.1 Watch Me is intentionally current-page/site-scoped; navigation recording is not yet a release claim.

### 9. Stale-element recovery
Cause page state to change after observation.

Pass:
- stale element returns a typed failure;
- agent re-observes;
- retries remain bounded.

### 10. Unsupported/protected page
Try a Chrome internal page.

Pass:
- BrowserCrew shows a clear unsupported-page/content-script error;
- no infinite retry.

## Public-release blockers to close after smoke testing
- harden approval classification beyond accessible-name regex;
- prevent Enter/key paths from bypassing submit approval;
- verify provider CORS/auth behavior in packaged Chrome;
- integrate screenshot fallback with model vision or remove the fallback claim for v0.1;
- verify single-agent multi-tab comparison end-to-end;
- create extension icons and Web Store listing assets;
- publish privacy policy / terms / support contact;
- review broad host permissions for Chrome Web Store disclosure and least privilege;
- add a usable task-history view or explicitly document history as retained local state only.

## Ship rule
Fix failures in the ten release scenarios before adding post-MVP features.
