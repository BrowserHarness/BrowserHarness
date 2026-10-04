import { describe, expect, it } from "vitest";
import {
  digestTrailEntry,
  renderTrailForPrompt
} from "./trail-compaction";

describe("trail compaction", () => {
  it("returns the plain trail when short", () => {
    expect(renderTrailForPrompt([])).toBe("No actions yet.");
    expect(renderTrailForPrompt(["a: 1", "b: 2"])).toBe("a: 1\nb: 2");
  });

  it("keeps the last 8 verbatim and digests the rest", () => {
    const trail = Array.from({ length: 12 }, (_, i) =>
      `read_page: {"ok":true,"data":{"title":"Page ${i}","url":"https://ex.com/${i}","text":"${"x".repeat(500)}"}}`
    );
    const out = renderTrailForPrompt(trail);
    expect(out).toContain("EARLIER STEPS (4 compacted):");
    expect(out).toContain("https://ex.com/0");
    expect(out).toContain("RECENT STEPS:");
    expect(out.split("\n").filter((l) => l.startsWith("read_page:")).length).toBe(8);
    expect(out.length).toBeLessThan(8 * 700 + 1800);
  });

  it("marks failed steps and bounds the digest", () => {
    expect(digestTrailEntry('click: {"ok":false,"error":{"code":"X"}}')).toContain("FAILED");
    const trail = Array.from({ length: 200 }, (_, i) =>
      `navigate: {"ok":true,"url":"https://example.com/${"p".repeat(60)}/${i}"}`
    );
    const out = renderTrailForPrompt(trail);
    expect(out).toContain("oldest omitted");
    expect(out.length).toBeLessThan(1700 + 8 * 200 + 200);
  });
});
