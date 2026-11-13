import { describe, expect, it } from "vitest";
import {
  bridgeAutoApproves,
  extensionPageApprovalGranted,
  isRiskyTrustedLabel
} from "./approval-grant";

describe("Bridge agents at autopilot levels", () => {
  it("stays blocked below level 4", () => {
    for (const mode of ["risky", "every", "auto"] as const) {
      expect(bridgeAutoApproves(mode, "Submit this form on a.com")).toBe(false);
    }
  });

  it("level 4 answers ordinary steps but not payments or passwords", () => {
    expect(bridgeAutoApproves("guarded", "Trusted click “Send” requires explicit approval.")).toBe(true);
    expect(bridgeAutoApproves("guarded", "Trusted click “Place order” requires explicit approval.")).toBe(false);
    expect(bridgeAutoApproves("guarded", "Type into the password or card field “Password” on a.com")).toBe(false);
  });

  it("level 5 answers everything", () => {
    expect(bridgeAutoApproves("full", "Trusted click “Place order” requires explicit approval.")).toBe(true);
  });
});

describe("privileged trusted-input approval grants", () => {
  const extensionId = "browserharness-extension-id";
  const extensionBaseUrl =
    "chrome-extension://browserharness-extension-id/";

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
