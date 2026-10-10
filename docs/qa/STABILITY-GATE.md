# BrowserHarness Stability Gate

## Why this exists
Real-user smoke testing is not a substitute for internal verification. User time is reserved for final acceptance and real-browser edge cases that cannot be reproduced safely in CI.

## Required order
1. Implement a coherent slice, not a one-line patch.
2. Add or update deterministic regression tests for the failure mode.
3. Pass TypeScript.
4. Pass unit tests.
5. Pass production build.
6. Validate MV3 output.
7. Package the extension.
8. Only then request one focused real-Chrome acceptance test.

## Provider acceptance gate
A provider/model is not considered active until:
- credentials and endpoint are present;
- model discovery succeeds when supported;
- the exact selected model passes a small inference health check;
- successful validation is stamped into local provider config.

Untested/stale provider configs must not execute tasks.

## Runtime separation
### Direct chat
Normal conversation, writing, brainstorming and explanation:
- never observe the current page;
- never require BrowserHarness action JSON;
- call the provider as ordinary chat;
- display plain model text.

### Browser agent
Tasks explicitly involving current page/tab/site/document/cursor/browser actions:
- observe page;
- enter bounded browser-agent loop;
- require structured action decisions;
- verify mutations;
- apply approval gates.

## Failure behavior
- Provider HTTP errors are surfaced with status and bounded detail.
- User Stop is distinct from provider/network abort.
- Model requests have bounded timeouts.
- Activity cards must leave the working state on failure.
- A failed model health check must not save that model as active.

## CI regression baseline
Current mandatory suites cover:
- chat-vs-browser task routing;
- NVIDIA plain direct-chat behavior;
- NVIDIA structured browser planning;
- NVIDIA compatibility fallback;
- provider rate-limit propagation;
- model health probing;
- model catalog discovery/sorting/error propagation;
- structured action parsing.

## User acceptance rule
Do not ask the user to install another build for every individual fix. Batch related fixes into a stability candidate and request the smallest possible acceptance check only after the full gate passes.

## Native API engine gate
`npm run gate:api-engine` runs, locally and never on GitHub Actions: the vendored upstream check, Bridge and extension tests, typecheck, build, Bridge bundle, MV3 contract and the real-Chromium fixture test (`smoke:api-engine`). `--quick` skips the browser test. Fixture results never count as real-site acceptance.
