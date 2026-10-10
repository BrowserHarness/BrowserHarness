import type { SiteCommand } from "../runtime/site-commands";

const TIER_WORDS: Record<1 | 2 | 3, string> = {
  1: "asks the site directly",
  2: "asks the site from your signed-in browser",
  3: "goes through the site's page"
};

/**
 * Plain words for a site command on the Skills screen: what it does, whether
 * it uses the site's own API, how it was checked and how it reaches the site.
 */
export function siteCommandDetail(command: SiteCommand, rememberedTier?: 1 | 2 | 3): { caption: string; what: string } {
  if (!command.api) {
    const what = command.kind === "read" ? "Gets data" : "Fills a form";
    return { caption: what.toLowerCase(), what };
  }
  const api = command.api;
  const parts = [api.side_effect === "read" ? "gets data from the site's API" : "changes data through the site's API (asks you first)"];
  if (command.recipe_kind === "hybrid") parts[0] += ", with the page as a fallback";
  parts.push(
    api.verification === "verified" ? "checked with a new input" : api.verification === "failed" ? "last check failed" : "not checked yet"
  );
  const tier = rememberedTier || api.learned_tier;
  if (tier) parts.push(TIER_WORDS[tier]);
  else if (api.min_tier === 3) parts.push(TIER_WORDS[3]);
  return { caption: parts.join(" · "), what: api.side_effect === "read" ? "Gets data from the site's API" : "Changes data through the site's API" };
}

/** The line Watch Me adds when the demonstration made data requests BrowserHarness could learn. */
export function watchApiNote(capture?: { recording_id: string; data_requests: number; inputs: string[] }): string {
  if (!capture || !capture.data_requests || !capture.inputs.length) return "";
  return ` It also made ${capture.data_requests} data request${capture.data_requests === 1 ? "" : "s"}: ask me to learn its API (recording ${capture.recording_id}, input ${capture.inputs.join(", ")}) within 15 minutes and later runs can skip the page.`;
}
