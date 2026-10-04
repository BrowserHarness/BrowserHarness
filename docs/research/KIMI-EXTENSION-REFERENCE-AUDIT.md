# Kimi Browser Extension 2.0.22 — Reference Architecture Audit

> Purpose: accelerate BrowserHarness engineering by studying the behavior and architecture of a proven shipped browser-agent extension.
>
> This document records independently observed mechanisms and product patterns. It is **not** a source-code copy. BrowserHarness implementations must remain independently authored and preserve BrowserHarness's own safety, permissions, provider-neutrality, and evaluation contracts.

## Reference package
Observed package:
- Product: Kimi Browser Extension / WebBridge
- Manifest version: MV3
- Extension version: 2.0.22

The shipped reference package uses a much broader permission envelope than BrowserHarness core, including:
- debugger
- tabs / activeTab
- storage
- alarms
- tabGroups
- windows
- sidePanel
- contextMenus
- notifications
- favicon
- webNavigation
- webRequest
- scripting
- unlimitedStorage
- <all_urls>

BrowserHarness now intentionally uses a comparable high-capability permission envelope in its primary build because browser-control functionality is a first-class product requirement, not an optional add-on.

## 1. Layered browser-control runtime

The reference does not rely on one interaction mechanism.

Observed layers:
1. accessibility/CDP snapshot and semantic element references;
2. DOM-level click/fill/evaluate;
3. CDP mouse and keyboard input for trusted/real input cases;
4. explicit low-level CDP escape hatch.

### BrowserHarness decision
Adopt the same layered control concept directly in the primary product:
1. ordinary semantic DOM tools;
2. real Accessibility.getFullAXTree/backend-node refs;
3. trusted CDP mouse/text/key input;
4. focus emulation and native dialog state;
5. structured network/upload/PDF tools;
6. raw CDP escape hatch.

BrowserHarness keeps its provider-neutral model layer, task sessions, Bridge, approvals, tests and Skills on top of that full browser-control substrate.

## 2. Semantic references

The reference uses Chrome's accessibility tree and stores a per-tab map from generated semantic refs to backend DOM node IDs.

Observed properties:
- semantic refs look like @eN;
- refs are regenerated/reset with fresh snapshots;
- refs can resolve back to backend DOM nodes;
- snapshot can be narrowed to a subtree/ref;
- interactive-only snapshot mode exists;
- text search can return an interactive ancestor ref.

### BrowserHarness state
Implemented:
- semantic @e refs;
- compact accessibility-style snapshot;
- stale-ref recovery via re-observation.

Difference:
- BrowserHarness Core currently derives refs from page DOM rather than Chrome Accessibility.getFullAXTree/backendDOMNodeId because that richer mechanism requires debugger/CDP.

### Improvement path
Advanced/Bridge should eventually use real AX/backend-node refs while keeping the Core ref contract compatible.

## 3. Navigation completion

The reference does not treat a tab URL update as successful navigation.

Observed behavior:
- waits for load completion;
- has a bounded timeout;
- polls document usability if the normal completion event is late;
- reports a timeout instead of allowing the agent to act on a half-loaded page;
- returns final tab state after redirects.

### BrowserHarness state
Implemented from this pattern:
- bounded page-usability gate;
- document-ready polling;
- final redirected URL capture;
- NAVIGATION_TIMEOUT failure.

## 4. Task sessions and tab ownership

The reference maps one agent task/session to a Chrome tab group.

Observed semantics:
- task-created tabs belong to the session;
- user foreground tabs can be explicitly borrowed;
- session tab lookup is constrained;
- tab/group bindings are persisted and stale bindings are pruned;
- tab grouping is retried because Chrome grouping can race.

### BrowserHarness state
Implemented:
- one task = one BrowserHarness session;
- starting user tab borrowed;
- BrowserHarness-created tabs owned and grouped;
- borrowed/unrelated tabs cannot be closed as owned;
- session-scoped list_tabs / find_tab;
- Local Bridge session ID maps directly to BrowserHarness task session.

Improvement added beyond the first BrowserHarness implementation:
- serialized session mutations to prevent concurrent tab events from losing state.

## 5. Storage race handling

The reference contains explicit serialized/confirmed storage update logic instead of assuming get → mutate → set is atomic.

Why it matters:
MV3 service-worker events can interleave. Tab creation, activation, navigation, grouping, recording, and bridge commands can update the same state concurrently.

### BrowserHarness state
Implemented:
- serialized task-session mutations;
- mutators re-read current state before merging their change;
- concurrent borrow/own operations have regression coverage.

Future:
- apply the same pattern to any bridge/workflow state that receives concurrent event updates.

## 6. Click hierarchy

The reference separates normal DOM click from trusted mouse input.

Observed DOM click path:
- resolve semantic ref or selector;
- scroll target into view;
- collect target geometry/text;
- invoke DOM click;
- optionally return a post-action page snapshot.

Observed trusted mouse path:
- calculate element center;
- verify element has a layout box;
- verify target is actually inside the viewport;
- hit-test elementFromPoint to detect overlays/occlusion;
- dispatch CDP mouse move/press/release;
- verify pointer events reached the page;
- account for background-tab rendering/focus limitations.

### BrowserHarness state
Implemented in the primary build:
- DOM click with semantic refs and verification;
- Accessibility-tree/backend-node refs;
- trusted CDP mouse input;
- focus emulation.

Next reliability improvement:
- stronger occlusion/hit-test verification before trusted click;
- explicit input-delivery verification after CDP dispatch.

## 7. Text input hierarchy

Observed reference paths:
- native input/textarea setter for framework-controlled form fields;
- contenteditable insertion;
- trusted text insertion via CDP Input.insertText;
- structured key sequences via Input.dispatchKeyEvent.

### BrowserHarness state
Implemented in Core:
- native value setters;
- beforeinput/input/change event sequencing;
- contenteditable range/insert fallback.

Primary build:
- trusted Input.insertText and Input.dispatchKeyEvent are implemented as the next escalation layer for editors/sites that reject synthetic DOM events.

## 8. Focus without stealing the user's foreground

The reference explicitly handles background tabs.

Observed strategy:
- check whether the page already has focus;
- prefer focus emulation when supported;
- only bring a tab/window to front as a last resort;
- surface whether the browser actually stole foreground focus.

### BrowserHarness state
Implemented:
1. task tabs stay backgrounded by default;
2. trusted CDP input enables focus emulation;
3. explicit switch_tab remains the foreground-changing action;
4. screenshot refuses to capture the wrong foreground tab.

## 9. Native JavaScript dialog handling

The reference tracks browser-level JavaScript dialogs via debugger events.

Observed behavior:
- remembers open alert/confirm/prompt state per tab;
- blocks unrelated CDP commands while a modal dialog is open;
- explicitly handles accept/dismiss;
- reports when an action ran but was interrupted by a newly opened dialog.

### BrowserHarness state
Implemented in the primary build:
- Page.javascriptDialogOpening/Closed tracking;
- dialog status;
- accept/dismiss/prompt handling.

## 10. Full-page reading

The reference has a dedicated read_page tool rather than inflating every planning snapshot.

Observed behavior:
- finds the real scroll container;
- preserves/restores original scroll position;
- scans page text as it scrolls;
- deduplicates repeated text;
- hard limits screens/chars/time;
- detects stalled rendering;
- detects endless/infinite feeds;
- signals background-tab rendering freezes;
- detects very low text + shadow-DOM hosts;
- supports continuation offsets;
- reads large frames separately;
- special-cases PDF.js viewers.

### BrowserHarness state
Implemented independently:
- dedicated read_page tool;
- compact observe_page remains fast;
- scroll-root scan;
- scroll restoration;
- text deduplication;
- char/screen/time budgets;
- next_start continuation;
- stalled/endless-feed/budget signals;
- shadow-host signal;
- readable frame metadata / frame-targeted reads.

BrowserHarness improvement:
- default extraction is intentionally 12k chars rather than a very large dump, reducing provider TPM/context pressure observed during Groq testing.

## 11. Iframe model

The reference treats significant iframes as separate documents.

Observed behavior:
- enumerates frames;
- probes content/render characteristics;
- limits the number of frames exposed;
- creates frame handles;
- reads a selected frame independently;
- identifies PDF.js-like viewers.

### BrowserHarness state
Initial independent implementation:
- read_page exposes accessible frame metadata and #f<frameId> handles;
- selected readable frames can be scanned independently.

Future:
- add stronger visibility/area ranking;
- report inaccessible cross-origin frames separately;
- add PDF-specific reading when justified.

## 12. Network capture

The reference provides a network tool with start/stop/list/detail semantics.

Observed capabilities:
- request/response event capture;
- wire headers;
- request post body;
- response body retrieval;
- explicit lifecycle.

### BrowserHarness state
Implemented in the primary build:
- network start/list/detail/stop;
- request/response lifecycle metadata;
- bounded capture entries;
- Network.getResponseBody retrieval when available.

Future hardening can add richer filtering/redaction and per-session capture policies without removing functionality.

## 13. File upload

The reference contains explicit upload handling and multiple file-input discovery.

Observed behavior:
- resolves a target file input or reports candidates;
- respects single vs multi-file inputs;
- uses browser-level file injection where required;
- handles Chrome's separate file-URL access limitation.

### BrowserHarness state
Implemented:
- upload uses DOM.setFileInputFiles against an AX-referenced file input;
- file paths are supplied by the local agent/runtime rather than discovered by the extension.

## 14. Save as PDF

The reference can render a page to PDF with paper/scale/background options.

### BrowserHarness state
Implemented:
- Page.printToPDF;
- Chrome downloads integration for generated PDFs.

## 15. Recording / Watch Me architecture

The shipped recorder is significantly richer than a simple list of clicks.

Observed event capture:
- pointer/click;
- input/change/focus-out;
- Enter/Tab keys;
- URL changes;
- new tabs;
- active-tab changes;
- dialogs/significant DOM changes;
- structured target metadata:
  - accessible name
  - role
  - label
  - element text
  - attributes
  - selector
  - coordinates/scroll state

Observed evidence capture:
- batched rrweb-like DOM event stream;
- screenshots on significant page reactions;
- multi-tab recording state;
- pause/resume;
- storage/quota handling.

Observed workflow distillation:
- recorded steps are treated as a reference plan, not a brittle macro;
- inputs/default values can become variables;
- the last recorded action defines the workflow boundary;
- the agent is instructed not to silently add irreversible actions beyond the recorded boundary;
- runtime adjustments can override the recorded plan without mutating the saved workflow.

### BrowserHarness priority
This is one of the highest-value next areas.

Recommended independent implementation:
1. enrich Watch Me targets/metadata;
2. record navigation/tab context;
3. capture before/after evidence for significant steps;
4. infer workflow inputs;
5. compile recording → candidate Skill;
6. replay with agent adaptation rather than exact selector macro;
7. enforce recorded irreversible-action boundary;
8. evaluate before Skill promotion.

This directly supports:
- Record → Skill
- Session → Skill
- Site → Skill

## 16. Storage quota / evidence budgeting

The reference monitors session-storage usage and has explicit quota behavior.

### BrowserHarness opportunity
As BrowserHarness starts recording richer evidence, add:
- per-session evidence budgets;
- size accounting;
- compaction/eviction policy;
- never allow screenshots/recording artifacts to silently exhaust extension storage.

## 17. Product UI/runtime separation

The reference has large independent bundles for:
- side panel;
- options;
- background runtime;
- recording content script;
- selection content script;
- frame reader;
- document/PDF rendering helpers.

### BrowserHarness lesson
Keep runtime capabilities modular. Do not let the chat UI become the owner of browser mechanics.

BrowserHarness already moved in this direction with:
- deterministic browser engine;
- background task sessions;
- Local Bridge daemon;
- content adapter boundary.

## BrowserHarness advantages to preserve

Do not lose these while adopting proven browser mechanics:
- provider-neutral model routing;
- OpenAI/Anthropic/NVIDIA/OpenAI-compatible support;
- Primary + Fallback;
- Chat vs Agent health checks;
- direct-chat/browser-agent separation;
- consequential-action approval policy;
- optional website permissions in Core;
- loopback pairing-token Bridge;
- deterministic browser-engine tests;
- candidate Skill evaluation/promotion rules;
- clearer split between Core and Advanced permissions.

## Adoption matrix

### Implemented in the primary BrowserHarness build
- task/session ownership
- semantic refs/snapshots
- serialized storage mutation
- bounded navigation readiness
- bounded read_page
- debugger/CDP attachment
- Accessibility.getFullAXTree/backend-node refs
- trusted mouse/keyboard/text input
- focus emulation
- native JavaScript dialog control
- raw CDP escape hatch
- network capture + response body
- file upload
- PDF export
- <all_urls>
- unlimitedStorage
- richer Watch Me v2 metadata

### Still to improve
- trusted-click occlusion/hit-test verification
- stronger cross-frame AX targeting
- cross-page/multi-tab Watch Me recording
- bounded recording evidence/storage budgets
- workflow/Skill compiler
- Site → Skill
- cross-runtime Bridge Skill evaluation

## Recommended implementation order

1. **Core reliability pass**
   - serialized session state — implemented
   - navigation readiness — implemented
   - read_page — implemented, verification pending
2. **Watch Me v2**
   - richer event/target metadata
   - tab/navigation capture
   - significant-change evidence
   - bounded storage budget
3. **Skill compiler**
   - Record → Skill
   - Session → Skill
   - variable inference
   - irreversible boundary
   - candidate evaluation
4. **Bridge cross-runtime evaluation**
   - promote SK-BROWSER-001 only after matrix passes
5. **Full browser-control parity** — implemented
   - CDP attach manager
   - AX/backend-node refs
   - trusted mouse/key/text
   - focus emulation
   - dialogs
   - network
   - upload
   - PDF
   - raw CDP
6. **Watch Me v2 cross-page/multi-tab**
7. **Skill compiler**
8. **Site → Skill**

## Current conclusion

The source confirms that BrowserHarness's direction is correct, but also shows where mature browser-agent reliability comes from: not one better prompt, but layered control, explicit browser state, bounded evidence extraction, session ownership, robust storage, and adaptive workflow replay.

BrowserHarness should use the reference to avoid rediscovering those engineering lessons while continuing to improve on permission minimization, provider neutrality, approval safety, deterministic testing, and portable Skills.
