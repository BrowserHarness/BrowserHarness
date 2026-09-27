import { describe, expect, it } from "vitest";
import {
  extensionPageApprovalGranted,
  isRiskyTrustedLabel
} from "./approval-grant";

describe("privileged trusted-input approval grants", () => {
  const extensionId = "browsercrew-extension-id";
  const extensionBaseUrl =
    "chrome-extension://browsercrew-extension-id/";

  it("accepts an explicit grant only from an extension page sender", () => {
    expect(
      extensionPageApprovalGranted(
        true,
        {
          id: extensionId,
          url: `${extensionBaseUrl}sidepanel.html`
        },
        extensionId,
        extensionBaseUrl
      )
    ).toBe(true);
  });

  it("rejects grants from content-script/tab senders even with the same extension id", () => {
    expect(
      extensionPageApprovalGranted(
        true,
        {
          id: extensionId,
          url: "https://shop.example/checkout",
          tab: { id: 7 }
        },
        extensionId,
        extensionBaseUrl
      )
    ).toBe(false);
  });

  it("rejects grants from another extension or without an explicit request", () => {
    expect(
      extensionPageApprovalGranted(
        true,
        {
          id: "another-extension",
          url: "chrome-extension://another-extension/panel.html"
        },
        extensionId,
        extensionBaseUrl
      )
    ).toBe(false);

    expect(
      extensionPageApprovalGranted(
        false,
        {
          id: extensionId,
          url: `${extensionBaseUrl}sidepanel.html`
        },
        extensionId,
        extensionBaseUrl
      )
    ).toBe(false);
  });

  it("classifies consequential trusted-action labels consistently", () => {
    expect(isRiskyTrustedLabel("Place order")).toBe(true);
    expect(isRiskyTrustedLabel("Save changes")).toBe(true);
    expect(isRiskyTrustedLabel("Continue")).toBe(false);
  });
});
