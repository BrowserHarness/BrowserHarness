# Kimi Browser Extension 2.0.22 — Reference Architecture Audit

> Purpose: accelerate BrowserCrew engineering by studying the behavior and architecture of a proven shipped browser-agent extension.
>
> This document records independently observed mechanisms and product patterns. It is **not** a source-code copy. BrowserCrew implementations must remain independently authored and preserve BrowserCrew's own safety, permissions, provider-neutrality, and evaluation contracts.

## Reference package
Observed package:
- Product: Kimi Browser Extension / WebBridge
- Manifest version: MV3
- Extension version: 2.0.22

The shipped reference package uses a much broader permission envelope than BrowserCrew core, including:
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

BrowserCrew should **not** mirror that permission envelope in the core package merely for implementation parity.

## 1. Layered browser-control runtime

The reference does not rely on one interaction mechanism.

Observed layers:
1. accessibility/CDP snapshot and semantic element references;
2. DOM-level click/fill/evaluate;
3. CDP mouse and keyboard input for trusted/real input cases;
4. explicit low-level CDP escape hatch.

### BrowserCrew decision
Preserve the same layered *concept*, but split it by trust surface:
- BrowserCrew Core: least-privilege DOM/scripting + semantic refs + approvals.
- BrowserCrew Advanced/Bridge: separately disclosed debugger/CDP capability.

Chrome does not allow debugger to be an optional permission, so it should not be silently added to Core.

## 2. Semantic references

The reference uses Chrome's accessibility tree and stores a per-tab map from generated semantic refs to backend DOM node IDs.

Observed properties:
- semantic refs look like @eN;
- refs are regenerated/reset with fresh snapshots;
- refs can resolve back to backend DOM nodes;
- snapshot can be narrowed to a subtree/ref;
- interactive-only snapshot mode exists;
- text search can return an interactive ancestor ref.

### BrowserCrew state
Implemented:
- semantic @e refs;
- compact accessibility-style snapshot;
- stale-ref recovery via re-observation.

Difference:
- BrowserCrew Core currently derives refs from page DOM rather than Chrome Accessibility.getFullAXTree/backendDOMNodeId because that richer mechanism requires debugger/CDP.

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

### BrowserCrew state
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

### BrowserCrew state
Implemented:
- one task = one BrowserCrew session;
- starting user tab borrowed;
- BrowserCrew-created tabs owned and grouped;
- borrowed/unrelated tabs cannot be closed as owned;
- session-scoped list_tabs / find_tab;
- Local Bridge session ID maps directly to BrowserCrew task session.

Improvement added beyond the first BrowserCrew implementation:
- serialized session mutations to prevent concurrent tab events from losing state.

## 5. Storage race handling

The reference contains explicit serialized/confirmed storage update logic instead of assuming get → mutate → set is atomic.

Why it matters:
MV3 service-worker events can interleave. Tab creation, activation, navigation, grouping, recording, and bridge commands can update the same state concurrently.

### BrowserCrew state
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

### BrowserCrew decision
Core:
- keep DOM click with semantic refs and mutation verification.

Advanced/Bridge:
- add trusted mouse input;
- copy the **verification model**, not the implementation:
  - layout-box check;
  - occlusion/hit-test check;
  - input-delivery verification;
  - clear fallback/errors.

## 7. Text input hierarchy

Observed reference paths:
- native input/textarea setter for framework-controlled form fields;
- contenteditable insertion;
- trusted text insertion via CDP Input.insertText;
- structured key sequences via Input.dispatchKeyEvent.

### BrowserCrew state
Implemented in Core:
- native value setters;
- beforeinput/input/change event sequencing;
- contenteditable range/insert fallback.

Advanced/Bridge:
- trusted insertText/send-keys path should become the final fallback for editors/sites that reject synthetic events.

## 8. Focus without stealing the user's foreground

The reference explicitly handles background tabs.

Observed strategy:
- check whether the page already has focus;
- prefer focus emulation when supported;
- only bring a tab/window to front as a last resort;
- surface whether the browser actually stole foreground focus.

### BrowserCrew improvement opportunity
Advanced/Bridge should implement a user-respecting focus policy:
1. already focused → act;
2. focus emulation → act without foreground takeover;
3. foreground activation only with explicit need/visibility disclosure.

This is a better UX than blindly switching tabs.

## 9. Native JavaScript dialog handling

The reference tracks browser-level JavaScript dialogs via debugger events.

Observed behavior:
- remembers open alert/confirm/prompt state per tab;
- blocks unrelated CDP commands while a modal dialog is open;
- explicitly handles accept/dismiss;
- reports when an action ran but was interrupted by a newly opened dialog.

### BrowserCrew improvement opportunity
Advanced/Bridge should model native dialogs as explicit browser state instead of timeouts/hangs.

Core cannot reliably implement this without debugger.

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

### BrowserCrew state
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

BrowserCrew improvement:
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

### BrowserCrew state
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

### BrowserCrew decision
Do not add webRequest/debugger network capture to Core simply for parity.

Advanced/Bridge candidate:
- network.start
- network.list
- network.detail
- network.stop

Must include:
- bounded capture memory;
- secret/header redaction;
- clear user disclosure;
- per-session isolation.

## 13. File upload

The reference contains explicit upload handling and multiple file-input discovery.

Observed behavior:
- resolves a target file input or reports candidates;
- respects single vs multi-file inputs;
- uses browser-level file injection where required;
- handles Chrome's separate file-URL access limitation.

### BrowserCrew opportunity
Add upload later as a separately evaluated capability because it materially expands data exfiltration risk.

Requirements:
- explicit file selection supplied by user/agent context;
- no arbitrary filesystem browsing;
- upload target verification;
- approval policy for sensitive destinations.

## 14. Save as PDF

The reference can render a page to PDF with paper/scale/background options.

### BrowserCrew decision
Useful Bridge/Advanced feature, not a Core MVP blocker.

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

### BrowserCrew priority
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

### BrowserCrew opportunity
As BrowserCrew starts recording richer evidence, add:
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

### BrowserCrew lesson
Keep runtime capabilities modular. Do not let the chat UI become the owner of browser mechanics.

BrowserCrew already moved in this direction with:
- deterministic browser engine;
- background task sessions;
- Local Bridge daemon;
- content adapter boundary.

## BrowserCrew advantages to preserve

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

### Adopt in Core
- task/session ownership
- semantic refs/snapshots
- storage mutation serialization
- bounded navigation readiness
- bounded read_page
- richer Watch Me metadata
- workflow boundary/safety semantics
- better frame discovery where possible without debugger
- evidence budgeting

### Advanced/Bridge only
- debugger/CDP attachment
- trusted mouse/keyboard input
- focus emulation
- native JavaScript dialog control
- raw CDP escape hatch
- network capture
- PDF printing if implemented through CDP

### Defer until justified
- broad <all_urls> install-time permission
- unlimitedStorage
- always-on all-site content scripts
- unrestricted evaluate/raw JavaScript tool in Core
- arbitrary filesystem upload access

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
5. **Advanced/Bridge distribution**
   - CDP attach manager
   - trusted mouse/key/text
   - focus emulation
   - dialogs
6. **Advanced tools**
   - network
   - upload
   - PDF
7. **Site → Skill**
   - build after observation/recording/evaluation contracts are stable

## Current conclusion

The source confirms that BrowserCrew's direction is correct, but also shows where mature browser-agent reliability comes from: not one better prompt, but layered control, explicit browser state, bounded evidence extraction, session ownership, robust storage, and adaptive workflow replay.

BrowserCrew should use the reference to avoid rediscovering those engineering lessons while continuing to improve on permission minimization, provider neutrality, approval safety, deterministic testing, and portable Skills.
