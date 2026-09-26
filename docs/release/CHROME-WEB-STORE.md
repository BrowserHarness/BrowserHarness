# Chrome Web Store Release Baseline — BrowserCrew v0.1

## Listing
**Name:** BrowserCrew

**Short description:** AI agents that can read and work in your browser with visible activity, approvals, and user-selected AI models.

## Core value
BrowserCrew lets users connect their own supported AI provider, give the current browser context a goal, and let one agent observe, navigate, type, click, work across tabs, and verify actions.

## Permission justification

### activeTab
Allows BrowserCrew to work with the tab on which the user invokes the extension without requesting blanket website access at install time.

### tabs
Required to identify, open, switch, and close tabs for single-agent multi-tab tasks.

### storage
Stores local provider configuration, model health, task history preferences, recorded workflows, and UI preferences.

### sidePanel
Provides BrowserCrew's primary chat-first Chrome side panel.

### scripting
Injects the BrowserCrew content runtime into user-authorized normal web pages.

### Known provider host permissions
Required for direct user-configured AI API requests to OpenAI, Anthropic, NVIDIA hosted NIM, and Groq.

### optional website host permissions
`http://*/*` and `https://*/*` are optional. They are requested only when the user enables all-sites access for cross-site/multi-tab browser automation or grants a custom compatible AI endpoint.

## Data-use declaration baseline
- No BrowserCrew cloud analytics in v0.1.
- No sale of user data.
- Provider API requests are sent directly to the provider configured by the user.
- Page content is sent only when required for a user-requested browser-agent task.
- Screenshots are sent only when a vision-capable model requests visual evidence.
- Provider credentials remain in Chrome extension local storage.

## Store assets still replaceable
The MVP package may use a temporary generated extension icon. Final polished store artwork can replace it without changing runtime behavior.

## Release gate
Do not publish publicly until the automated MVP gate passes and the final real-Chrome manual acceptance pass is completed.
