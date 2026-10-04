# BrowserHarness v0.1 Automated MVP Gate

## Status
**PASS on the feature-complete code candidate.**

Verified code evidence:
- SHA: `76218f69e16afae0f079d0cf4b4956754df39dfa`
- GitHub Actions run: `36262532519`
- test files: **14 passed**
- tests: **63 passed**
- production build: **PASS**
- MV3 validation: **PASS**
- machine-checkable MVP contract: **PASS**
- package/upload: **PASS**

## Runtime scenario coverage
The deterministic browser engine suite covers:
- current-page read with no mutation;
- navigation and re-observation;
- site search through type + Enter + result verification;
- form fill without submission;
- multi-tab evidence retention for comparison;
- consequential-action approval cancellation;
- stop before further execution;
- pause gate before model decisions;
- stale-element re-observation and retry;
- repeated-action loop blocking;
- protected/unsupported page error;
- screenshot capture passed to the next planning turn.

## Model/provider coverage
Automated tests cover:
- direct chat vs browser intent routing;
- NVIDIA plain chat and structured-agent behavior;
- NVIDIA compatibility fallback;
- provider rate-limit propagation;
- one-hop recoverable fallback;
- no silent fallback on authentication failure;
- model discovery/sorting/errors;
- model capability classification;
- separate Chat + Agent health contracts;
- structured BrowserHarness action parsing;
- multimodal screenshot requests for vision models;
- screenshot rejection for non-vision models.

## Local state/privacy coverage
Automated tests cover:
- Watch Me workflow persistence/version replacement;
- task-history retention when enabled;
- no task-history retention when disabled;
- task-history clearing;
- custom endpoint origin permission behavior;
- optional all-sites permission contract.

## Release/package coverage
The automated contract validator requires:
- all 11 browser tools in `machine/browser-tools.json`;
- multi-connection + fallback model contract;
- functional runtime/history/site-adapter modules;
- privacy, terms, support, and Web Store release docs;
- MV3 package entry points;
- temporary 16/32/48/128 PNG extension icons;
- known provider API host access;
- blanket website access only as optional host permissions;
- no static blanket content script.

## Manual boundary
The automated gate intentionally does not claim to prove:
- Chrome UI permission prompts;
- live provider credentials/CORS/account quotas;
- current Google Docs editor internals;
- real DOM event capture during Watch Me;
- real-site approval UX;
- Chrome Web Store review behavior.

Those are reserved for the final focused manual acceptance gate.
