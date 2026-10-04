import { describe, expect, it } from "vitest";
import {
  addGrant,
  isHostGranted,
  normalizeGrantHost,
  removeGrant
} from "./site-grants";

describe("site approval grants", () => {
  it("normalizes hosts and urls", () => {
    expect(normalizeGrantHost("https://www.Shop.Example.com/x")).toBe("shop.example.com");
    expect(normalizeGrantHost("WWW.Example.com")).toBe("example.com");
  });

  it("covers the host and its subdomains but not lookalikes", () => {
    const grants = addGrant([], "example.com", "t");
    expect(isHostGranted(grants, "example.com")).toBe(true);
    expect(isHostGranted(grants, "shop.example.com")).toBe(true);
    expect(isHostGranted(grants, "notexample.com")).toBe(false);
    expect(isHostGranted(grants, "example.com.evil.io")).toBe(false);
  });

  it("refuses ungrantable hosts and dedupes", () => {
    expect(addGrant([], "")).toEqual([]);
    expect(addGrant([], "chrome")).toEqual([]);
    const once = addGrant([], "a.com", "t");
    expect(addGrant(once, "www.a.com", "t")).toHaveLength(1);
    expect(removeGrant(once, "a.com")).toEqual([]);
  });
});
