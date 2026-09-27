import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(resolve(process.cwd(), "public/manifest.json"), "utf8")
) as {
  manifest_version: number;
  permissions?: string[];
  host_permissions?: string[];
  content_scripts?: unknown[];
  icons?: Record<string, string>;
  action?: {
    default_icon?: Record<string, string>;
  };
};

describe("MV3 release manifest", () => {
  it("uses Manifest V3 and the full browser-agent permission envelope", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(
      expect.arrayContaining([
        "activeTab",
        "alarms",
        "contextMenus",
        "debugger",
        "favicon",
        "notifications",
        "sidePanel",
        "scripting",
        "storage",
        "tabGroups",
        "tabs",
        "unlimitedStorage",
        "webNavigation",
        "webRequest",
        "windows"
      ])
    );
  });

  it("has all-site host access for autonomous cross-site operation", () => {
    expect(manifest.host_permissions).toEqual(
      expect.arrayContaining(["<all_urls>"])
    );
  });

  it("keeps runtime injection dynamic instead of static content scripts", () => {
    expect(manifest.content_scripts).toBeUndefined();
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
