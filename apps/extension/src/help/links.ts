// Where "Read the guide" goes. Until the BrowserHarness website is live, the
// guides open inside the extension (Settings → Help). When it is, set
// DOCS_SITE_URL and every link goes to the website page with the same name.
import type { GuideSlug } from "./problems";

export const DOCS_SITE_URL = "";

export function guideUrl(slug: GuideSlug, site = DOCS_SITE_URL): string {
  if (site) return `${site.replace(/\/+$/, "")}/help/${slug}`;
  return chrome.runtime.getURL(`settings.html#help/${slug}`);
}

/** Opens a guide in a new tab. */
export function openGuide(slug: GuideSlug): void {
  void chrome.tabs.create({ url: guideUrl(slug) });
}
