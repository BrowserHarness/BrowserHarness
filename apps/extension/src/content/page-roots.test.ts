import { describe, expect, it } from "vitest";
import { highestRefNumber, inTopViewport, viewportFirst } from "./page-roots";

describe("page roots", () => {
  it("lists on-screen elements first, keeping page order", () => {
    const items = [
      { id: 1, in_viewport: false },
      { id: 2 },
      { id: 3, in_viewport: false },
      { id: 4, in_viewport: true }
    ];
    expect(viewportFirst(items).map((item) => item.id)).toEqual([2, 4, 1, 3]);
  });

  it("places iframe content using the frame's offset", () => {
    const viewport = { width: 800, height: 600 };
    const rect = { left: 10, top: 10, right: 50, bottom: 30 };
    expect(inTopViewport(rect, { offsetX: 0, offsetY: 0 }, viewport)).toBe(true);
    expect(inTopViewport(rect, { offsetX: 0, offsetY: 700 }, viewport)).toBe(false);
  });

  it("continues ref numbers after the highest one on the page", () => {
    expect(highestRefNumber(["e2", null, "e17", "bc-4", "e9"])).toBe(17);
    expect(highestRefNumber([])).toBe(0);
  });
});
