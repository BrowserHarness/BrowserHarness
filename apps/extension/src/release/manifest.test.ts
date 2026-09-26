import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(resolve(process.cwd(), "public/manifest.json"), "utf8")
) as {
  manifest_version: number;
  permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  content_scripts?: unknown[];
  icons?: Record<string, string>;
  action?: {
    default_icon?: Record<string, string>;
  };
};

describe("MV3 release manifest", () => {
  it("uses Manifest V3 and only required extension permissions", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(
      expect.arrayContaining([
        "activeTab",
        "tabs",
        "storage",
        "sidePanel",
        "scripting"
      ])
    );
  });

  it("keeps blanket website access optional", () => {
    expect(manifest.host_permissions).not.toContain("http://*/*");
    expect(manifest.host_permissions).not.toContain("https://*/*");
    expect(manifest.optional_host_permissions).toEqual(
      expect.arrayContaining(["http://*/*", "https://*/*"])
    );
    expect(manifest.content_scripts).toBeUndefined();
  });

  it("keeps known provider API hosts available", () => {
    expect(manifest.host_permissions).toEqual(
      expect.arrayContaining([
        "https://api.openai.com/*",
        "https://api.anthropic.com/*",
        "https://integrate.api.nvidia.com/*",
        "https://api.groq.com/*"
      ])
    );
  });

  it("declares the required extension icon sizes", () => {
    expect(manifest.icons).toEqual({
      "16": "icons/icon16.png",
      "32": "icons/icon32.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    });
    expect(manifest.action?.default_icon).toEqual({
      "16": "icons/icon16.png",
      "32": "icons/icon32.png"
    });
  });
});
