// BrowserHarness patch (see VENDORED.json): stands in for playwright-core.
// BrowserHarness drives the browser through its extension only, so upstream's
// own Chrome tiers, capture and login window never start here.
export class BrowserTierUnavailable extends Error {
  constructor() {
    super(
      "BROWSERHARNESS_BROWSER_TIER_UNAVAILABLE: API Anything's own browser is not used inside BrowserHarness; " +
        "BrowserHarness runs in-page and browser tiers through its extension"
    );
    this.name = "BrowserTierUnavailable";
  }
}
const unavailable = async () => {
  throw new BrowserTierUnavailable();
};
export const chromium = {
  launch: unavailable,
  launchPersistentContext: unavailable,
  connectOverCDP: unavailable,
  executablePath: () => ""
};
