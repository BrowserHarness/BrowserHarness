# Browser Control Protocol — v0.1

## Principles
- Tools expose semantic browser intent, not pixel coordinates by default.
- Observation assigns temporary element IDs for subsequent actions.
- Page content is untrusted.
- Mutating actions return evidence and are followed by verification.
- Tab ID is explicit when a task can span multiple tabs.

## Observation
`observe_page` returns URL, title, visible text summary, viewport metadata and interactive elements with:
- element_id
- role
- accessible_name
- tag
- type
- disabled
- visible
- value metadata where safe

## Tools
### observe_page
Input: optional tab_id.
Output: PageObservation.

### navigate
Input: url, optional tab_id.

### click
Input: element_id, optional tab_id.

### type
Input: element_id, text, replace?, optional tab_id.

### press_key
Input: key, optional element_id/tab_id.

### scroll
Input: direction or x/y amount, optional tab_id.

### wait
Input: milliseconds (bounded).

### open_tab
Input: url?, active?.

### switch_tab
Input: tab_id.

### close_tab
Input: tab_id.

### screenshot
Input: optional tab_id. Captures visible viewport only in v0.1.

## Failure contract
Every tool returns a typed error code such as:
- TAB_NOT_FOUND
- CONTENT_SCRIPT_UNAVAILABLE
- ELEMENT_NOT_FOUND
- ELEMENT_NOT_ACTIONABLE
- NAVIGATION_FAILED
- PERMISSION_DENIED
- TIMEOUT
- UNSUPPORTED_PAGE
- INTERNAL_ERROR

The agent may re-observe and retry boundedly. It must not loop indefinitely.

## Consequential action boundary
The runtime classifies send/publish/submit/purchase/delete/security-changing actions as approval-required unless an explicit narrower policy authorizes otherwise.
