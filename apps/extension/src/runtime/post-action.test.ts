import { describe, expect, it } from "vitest";
import { changesPage, ranWithoutPage } from "./post-action";

describe("looking at the page after an action", () => {
  it("skips the settle wait and observation for a learned API run, which used no page", () => {
    expect(changesPage("site_skill", { action: "run" })).toBe(true);
    expect(ranWithoutPage("site_skill", { ok: true, data: { run: { output: { data: [], api: { tier: 1 } } } } })).toBe(true);
    expect(ranWithoutPage("site_skill", { ok: true, data: { run: { output: { submitted: true } } } })).toBe(false);
    expect(ranWithoutPage("click", { ok: true, data: { run: { output: { api: {} } } } })).toBe(false);
  });
});
