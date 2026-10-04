# BrowserHarness Support

## MVP support channel
Use the issue tracker for the BrowserHarness product repository:

`BrowserHarness/browserharness`

When reporting an MVP issue, include:
- BrowserHarness version/build SHA;
- Chrome version;
- provider type and model ID, but **never the API key**;
- the task that was attempted;
- visible BrowserHarness error/activity text;
- whether the issue is reproducible on a normal website, Google Docs, or a protected Chrome page.

## Never include
- API keys;
- passwords;
- cookies or session tokens;
- private document contents unless essential and intentionally shared;
- payment or identity information.

## Provider outages and limits
HTTP 401/403/429/5xx errors may originate from the configured AI provider. BrowserHarness surfaces these errors and can use one validated fallback model for recoverable failures when configured.
