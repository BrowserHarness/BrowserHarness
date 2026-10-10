import { describe, expect, it } from "vitest";
import { siteCommandDetail, watchApiNote } from "./site-command-detail";
import type { SiteCommand } from "../runtime/site-commands";

const base: SiteCommand = {
  name: "shop-search",
  key: "SK:r",
  title: "Search",
  site: "shop.example",
  origin: "https://shop.example",
  entry_url: "https://shop.example/search",
  kind: "read",
  status: "proven",
  skill_id: "SK",
  revision_id: "rev",
  recipe_id: "r",
  parameters: [],
  runs: 1,
  worked: 1
};

describe("Skills screen wording for a site command", () => {
  it("names a form or page read plainly", () => {
    expect(siteCommandDetail(base)).toEqual({ caption: "gets data", what: "Gets data" });
    expect(siteCommandDetail({ ...base, kind: "form" }).caption).toBe("fills a form");
  });

  it("says a learned API operation's type, check and transport", () => {
    const api: SiteCommand = {
      ...base,
      needs_page: false,
      recipe_kind: "api",
      api: { operation_id: "op", side_effect: "read", verification: "verified", min_tier: 1, learned_tier: 1 }
    };
    expect(siteCommandDetail(api).caption).toBe("gets data from the site's API · checked with a new input · asks the site directly");
    expect(siteCommandDetail(api, 2).caption).toMatch(/from your signed-in browser$/);
    const write = { ...api, recipe_kind: "hybrid" as const, api: { ...api.api!, side_effect: "write" as const, verification: "unverified" as const, learned_tier: undefined, min_tier: 3 as const } };
    expect(siteCommandDetail(write)).toEqual({
      caption: "changes data through the site's API (asks you first), with the page as a fallback · not checked yet · goes through the site's page",
      what: "Changes data through the site's API"
    });
  });

  it("mentions a Watch Me capture only when there is something to learn", () => {
    expect(watchApiNote()).toBe("");
    expect(watchApiNote({ recording_id: "r", data_requests: 0, inputs: ["search"] })).toBe("");
    expect(watchApiNote({ recording_id: "r1", data_requests: 2, inputs: ["search"] })).toMatch(/2 data requests.*recording r1, input search/);
  });
});
