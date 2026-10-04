# BrowserHarness Privacy — v0.1 MVP

BrowserHarness is a local-first Chrome extension. The v0.1 MVP does not operate a BrowserHarness cloud backend.

## Data stored locally
BrowserHarness may store the following in Chrome extension local storage:
- AI provider connection configuration and API keys;
- validated model health/capability metadata;
- Primary/Fallback routing preferences;
- completed task history when local history retention is enabled;
- recorded Watch Me workflows;
- appearance and privacy preferences.

Task history can be disabled and cleared from Settings.

## Data sent to AI providers
When the user submits a request, BrowserHarness sends only the information needed to the selected AI provider:
- the user's prompt;
- bounded page observations for browser-agent tasks;
- retained evidence from a limited number of observed tabs when needed for the same task;
- a screenshot only when a vision-capable model explicitly requests visual evidence.

Provider requests go directly from the extension to the provider endpoint configured by the user.

## Browser access
BrowserHarness is a full autonomous browser agent and declares broad browser access in its primary build. It can operate across normal websites, tabs and windows; use Chrome DevTools Protocol for accessibility-tree targeting and trusted input; inspect browser/network activity; and execute user-requested cross-site workflows.

The same access also allows direct requests to supported AI providers and user-configured compatible endpoints.

## Analytics
The v0.1 MVP does not send BrowserHarness product analytics to a BrowserHarness cloud service.

## Sensitive actions
BrowserHarness requires explicit user approval before consequential actions such as send, submit, purchase, delete, or account/security changes.

## Secrets
Provider API keys are never committed to BrowserHarness source repositories and are not included in task activity output.

## Deletion
Users can clear task history from Settings. Removing the extension through Chrome removes its extension-local storage according to Chrome's extension storage behavior.

## Third-party providers
AI providers process data according to their own terms and privacy policies. Users choose and configure their provider directly.

## Scope
This document describes the BrowserHarness v0.1 MVP architecture and should be updated before any cloud sync, hosted inference, telemetry, team features, or remote storage is introduced.
