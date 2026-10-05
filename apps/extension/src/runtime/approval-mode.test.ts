import { describe, expect, it } from "vitest";
import { approvalFor, autoApproves, describeAction } from "./approval-mode";
import type { PageObservation } from "./protocol";

const page: PageObservation = {
  tab_id: 1,
  url: "https://shop.example.com/cart",
  title: "Cart",
  visible_text: "",
  elements: [
    { element_id: "@e1", tag: "button", role: "button", accessible_name: "Add note", visible: true, disabled: false }
  ]
};

describe("approval modes", () => {
  it("asks only for risky actions by default", () => {
    expect(approvalFor("risky", null, page, "click", { element_id: "@e1" })).toBeNull();
    expect(approvalFor("risky", "Submit this form", page, "click", {})).toBe("Submit this form");
  });

  it("asks before every page-changing action in ask-every-time mode", () => {
    expect(approvalFor("every", null, page, "click", { element_id: "@e1" })).toBe(
      "Click “Add note” on shop.example.com"
    );
    expect(approvalFor("every", null, page, "navigate", { url: "https://a.com" })).toBe("Open https://a.com");
    expect(approvalFor("every", null, page, "scroll", {})).toBeNull();
    expect(approvalFor("every", null, page, "read_page", {})).toBeNull();
  });

  it("answers yes on its own in automatic mode, except payments and account security", () => {
    expect(autoApproves("auto", "Submit this form on example.com")).toBe(true);
    expect(autoApproves("auto", "Activate “Place order” on shop.example.com")).toBe(false);
    expect(autoApproves("auto", "Activate “Change password”")).toBe(false);
    expect(autoApproves("risky", "Submit this form")).toBe(false);
  });

  it("describes typing without the whole text", () => {
    expect(describeAction(page, "type", { element_id: "@e1", text: "x".repeat(100) })).toMatch(/^Type “x{60}” into/);
  });
});
