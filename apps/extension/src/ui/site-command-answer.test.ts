import { describe, expect, it } from "vitest";
import { markdownTable, rowsIn, siteCommandAnswer } from "./site-command-answer";
import type { SiteCommand } from "../runtime/site-commands";

const command: SiteCommand = {
  name: "shop-search",
  key: "k",
  title: "Shop: search",
  site: "shop.example.com",
  origin: "https://shop.example.com",
  entry_url: "https://shop.example.com/",
  kind: "read",
  status: "testing",
  skill_id: "s",
  revision_id: "r",
  recipe_id: "recipe-api-1",
  parameters: [],
  runs: 0,
  worked: 0
};

describe("site command answers", () => {
  it("finds the list inside a response", () => {
    expect(rowsIn([{ a: 1 }])).toEqual([{ a: 1 }]);
    expect(rowsIn({ meta: { total: 2 }, data: { items: [{ a: 1 }, { a: 2 }] } })).toEqual([{ a: 1 }, { a: 2 }]);
    expect(rowsIn({ text: "hi" })).toBeNull();
    expect(rowsIn([1, 2])).toBeNull();
  });

  it("shows lists as a table and escapes pipes", () => {
    expect(markdownTable([{ name: "a|b", price: 2 }, { name: "c", extra: { x: 1 } }])).toBe(
      ["| name | price | extra |", "| --- | --- | --- |", "| a\\|b | 2 |  |", '| c |  | {"x":1} |'].join("\n")
    );
    const answer = siteCommandAnswer(command, { ok: true, data: { output: { results: [{ name: "Kettle" }] } } });
    expect(answer).toContain("1 result.");
    expect(answer).toContain("| Kettle |");
  });

  it("explains failures, forms and other data", () => {
    expect(
      siteCommandAnswer(command, { ok: false, error: { code: "SITE_SKILL_VERIFICATION_FAILED", message: "no longer matches" } })
    ).toContain("has changed since BrowserHarness learned it");
    expect(siteCommandAnswer({ ...command, kind: "form" }, { ok: true, data: { submitted: true } })).toContain("filled and sent");
    expect(siteCommandAnswer(command, { ok: true, data: { output: { count: 3 } } })).toContain('"count": 3');
  });
});
