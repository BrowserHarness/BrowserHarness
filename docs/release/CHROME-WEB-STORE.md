# Chrome Web Store Release Baseline — BrowserHarness

## Listing
**Name:** BrowserHarness

**Short description:** A full browser AI agent with user-selected models, trusted browser control, local-agent Bridge, reusable workflows, and visible activity.

## Core value
BrowserHarness is designed to operate the real browser, not just chat about webpages. It can observe, navigate, type, click, work across tabs/windows, use accessibility-tree/CDP targeting, inspect network activity, upload files supplied by the user/agent runtime, export pages as PDF, and verify actions.

## Permission justification

### <all_urls>
BrowserHarness is an autonomous cross-site browser agent. Tasks can navigate across arbitrary websites and user sessions without stopping for per-origin permission grants.

### debugger
Powers Chrome DevTools Protocol capabilities used by BrowserHarness for:
- Accessibility.getFullAXTree semantic targeting;
- backend DOM node resolution;
- trusted mouse/keyboard/text input;
- background-tab focus emulation;
- native JavaScript dialog handling;
- network response-body inspection;
- file-input injection;
- print-to-PDF;
- raw CDP escape-hatch operations.

### webNavigation
Provides reliable navigation lifecycle information for cross-page automation and Watch Me recording.

### webRequest
Supports browser/network observability alongside CDP network inspection.

### unlimitedStorage
Supports local task/workflow/recording/evidence storage without small extension quotas becoming a reliability limiter.

### downloads
Writes BrowserHarness-generated PDFs to Chrome downloads.

### tabs / windows / tabGroups
Required for session-owned multi-tab and multi-window browser tasks and task grouping.

### scripting
Injects BrowserHarness's runtime into normal web documents when DOM-level observation or interaction is appropriate.

### activeTab
Supports user-invoked current-tab attachment and browser context.

### storage
Stores local provider configuration, model health, task/session state, workflows, preferences, Bridge settings, and history.

### sidePanel
Provides BrowserHarness's chat-first interface.

### alarms
Supports resilient extension/agent runtime housekeeping.

### contextMenus
Supports BrowserHarness actions launched from browser context.

### notifications
Supports user-visible browser-agent notifications.

### favicon
Supports tab/site visual context.

## Data-use baseline
- BrowserHarness currently has no BrowserHarness-hosted cloud analytics requirement for browser execution.
- Provider API requests are sent directly to providers configured by the user.
- Page/network/browser evidence is processed only for user-requested agent work.
- Provider credentials remain in Chrome extension-local storage.
- Local Bridge binds to loopback and uses a pairing token.

## Release gate
Public release still requires automated CI/evaluation gates plus the final real-Chrome acceptance pass.
