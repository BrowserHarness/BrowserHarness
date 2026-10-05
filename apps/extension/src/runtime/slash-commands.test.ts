import { describe, expect, it } from "vitest";
import { helpText, parseSlashCommand, slashSuggestions } from "./slash-commands";
import type { UserSkill } from "./skills";

const skill = { id: "1", slug: "check-prices", name: "Check prices" } as UserSkill;

describe("slash commands", () => {
  it("parses built-ins, Skills and unknown commands", () => {
    expect(parseSlashCommand("/remember I live in Pune", [skill])).toEqual({ kind: "builtin", name: "remember", args: "I live in Pune" });
    expect(parseSlashCommand("/check-prices size 9", [skill])).toMatchObject({ kind: "skill", args: "size 9" });
    expect(parseSlashCommand("/nope", [skill])).toEqual({ kind: "unknown", name: "nope" });
    expect(parseSlashCommand("open /path", [skill])).toEqual({ kind: "none" });
    expect(parseSlashCommand("/Users/me/file.txt", [skill])).toEqual({ kind: "none" });
  });

  it("suggests commands while typing", () => {
    expect(slashSuggestions("/", [skill]).map((item) => item.name)).toContain("check-prices");
    expect(slashSuggestions("/rem", [skill]).map((item) => item.name)).toEqual(["remember"]);
    expect(slashSuggestions("/remember x", [skill])).toEqual([]);
    expect(helpText([skill])).toContain("`/check-prices`");
  });
});
