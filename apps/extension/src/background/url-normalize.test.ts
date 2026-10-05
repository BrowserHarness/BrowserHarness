import { describe, expect, it } from "vitest";
import { normalizeNavigableUrl } from "./url-normalize";

describe("navigation URLs from the model", () => {
  it("adds https:// to bare domains and paths", () => {
    expect(normalizeNavigableUrl("amazon.com")).toBe("https://amazon.com");
    expect(normalizeNavigableUrl(" www.google.com/search?q=ai ")).toBe(
      "https://www.google.com/search?q=ai"
    );
    expect(normalizeNavigableUrl("//example.com/x")).toBe("https://example.com/x");
  });

  it("keeps full URLs and uses http for this computer", () => {
    expect(normalizeNavigableUrl("https://docs.google.com/")).toBe("https://docs.google.com/");
    expect(normalizeNavigableUrl("about:blank")).toBe("about:blank");
    expect(normalizeNavigableUrl("localhost:3000/app")).toBe("http://localhost:3000/app");
  });
});
