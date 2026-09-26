import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALL_SITE_ORIGINS,
  ensureEndpointAccess,
  originPatternForUrl
} from "./browser-access";

const contains = vi.fn();
const request = vi.fn();

beforeEach(() => {
  contains.mockReset();
  request.mockReset();
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      permissions: {
        contains,
        request,
        remove: vi.fn()
      }
    }
  });
});

describe("browser access permissions", () => {
  it("builds least-privilege origin patterns", () => {
    expect(
      originPatternForUrl("https://api.example.com/v1/models")
    ).toBe("https://api.example.com/*");
    expect(originPatternForUrl("chrome://extensions")).toBeNull();
  });

  it("keeps all-sites access as an explicit optional pair", () => {
    expect(ALL_SITE_ORIGINS).toEqual([
      "http://*/*",
      "https://*/*"
    ]);
  });

  it("does not reprompt when custom endpoint access already exists", async () => {
    contains.mockResolvedValue(true);
    expect(
      await ensureEndpointAccess("https://api.example.com/v1")
    ).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("requests only the custom endpoint origin when needed", async () => {
    contains.mockResolvedValue(false);
    request.mockResolvedValue(true);

    expect(
      await ensureEndpointAccess("https://api.example.com/v1")
    ).toBe(true);
    expect(request).toHaveBeenCalledWith({
      origins: ["https://api.example.com/*"]
    });
  });
});
