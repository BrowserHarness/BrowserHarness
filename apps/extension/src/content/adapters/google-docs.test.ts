import { describe, expect, it } from "vitest";
import {
  GOOGLE_DOCS_EDITOR_ID,
  isGoogleDocsLocation
} from "./google-docs";

describe("Google Docs adapter", () => {
  it("recognizes docs.google.com", () => {
    expect(isGoogleDocsLocation({ hostname: "docs.google.com" } as Location)).toBe(true);
  });

  it("rejects non-Docs hosts", () => {
    expect(isGoogleDocsLocation({ hostname: "example.com" } as Location)).toBe(false);
  });

  it("keeps a stable semantic editor id", () => {
    expect(GOOGLE_DOCS_EDITOR_ID).toBe("bc-google-doc-editor");
  });
});
