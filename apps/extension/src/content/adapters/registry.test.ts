import { describe, expect, it } from "vitest";
import { adapterForUrl } from "./registry";

describe("site adapter registry", () => {
  it("selects Google Docs adapter", () => {
    expect(
      adapterForUrl("https://docs.google.com/document/d/123/edit")
    ).toBe("google-docs");
  });

  it("uses generic adapter elsewhere", () => {
    expect(adapterForUrl("https://example.com")).toBe("generic-web");
  });
});
