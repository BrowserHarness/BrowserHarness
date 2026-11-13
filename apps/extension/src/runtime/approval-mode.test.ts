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

  it("answers everything at level 4 except payments, passwords and account security", () => {
    expect(autoApproves("guarded", "Submit this form on example.com")).toBe(true);
    expect(autoApproves("guarded", "Run Site Skill “X” operation “Y” on a.com? It may change data there (not known to be read-only).")).toBe(true);
    expect(autoApproves("guarded", "Activate “Place order” on shop.example.com")).toBe(false);
    expect(autoApproves("guarded", "Activate “Change password”")).toBe(false);
  });

  it("answers everything at level 5, payments included", () => {
    expect(autoApproves("full", "Activate “Place order” on shop.example.com")).toBe(true);
    expect(autoApproves("full", "Type into the password or card field “Card number” on a.com")).toBe(true);
    expect(autoApproves("full", "Run Site Skill “X” operation “Y” on a.com? It may change data there (not known to be read-only).")).toBe(true);
  });

  it("level 3 still asks for every-time writes", () => {
    expect(autoApproves("auto", "Run Site Skill “X” operation “Y” on a.com? It may change data there (not known to be read-only).")).toBe(false);
  });

  it("level 4 keeps password and card fields for the person", () => {
    const form: PageObservation = {
      ...page,
      elements: [
        { element_id: "@p", tag: "input", role: "textbox", type: "password", accessible_name: "Your secret", visible: true, disabled: false },
        { element_id: "@c", tag: "input", role: "textbox", accessible_name: "Card number", visible: true, disabled: false },
        { element_id: "@n", tag: "input", role: "textbox", accessible_name: "Full name", visible: true, disabled: false }
      ]
    };
    const pw = approvalFor("guarded", null, form, "type", { element_id: "@p", text: "x" });
    const card = approvalFor("guarded", null, form, "trusted_type", { element_id: "@c", text: "4" });
    expect(pw).toMatch(/password or card field/);
    expect(card).toMatch(/password or card field/);
    expect(autoApproves("guarded", pw!)).toBe(false);
    expect(approvalFor("guarded", null, form, "type", { element_id: "@n", text: "Ann" })).toBeNull();
    expect(approvalFor("full", null, form, "type", { element_id: "@p", text: "x" })).toBeNull();
    expect(approvalFor("auto", null, form, "type", { element_id: "@p", text: "x" })).toBeNull();
  });

  it("level 4 treats Pinterest Pin fields as ordinary, but a bank PIN as secret", () => {
    const names = [
      "Pin title",
      "Pin description",
      "Tell everyone what your Pin is about",
      "Add your title",
      "Add a destination link",
      "Choose a board",
      "Save Pin",
      "Search Pinterest",
      "Create Pin"
    ];
    for (const name of names) {
      const form: PageObservation = {
        ...page,
        url: "https://www.pinterest.com/pin-creation-tool/",
        elements: [{ element_id: "@f", tag: "input", role: "textbox", accessible_name: name, visible: true, disabled: false }]
      };
      expect(approvalFor("guarded", null, form, "type", { element_id: "@f", text: "Weekly ADHD planner" })).toBeNull();
    }
    for (const name of ["PIN", "Enter your PIN", "PIN code", "Card expiry", "CVV"]) {
      const form: PageObservation = {
        ...page,
        elements: [{ element_id: "@f", tag: "input", role: "textbox", accessible_name: name, visible: true, disabled: false }]
      };
      expect(approvalFor("guarded", null, form, "type", { element_id: "@f", text: "1" })).toMatch(/password or card field/);
    }
  });

  it("describes typing without the whole text", () => {
    expect(describeAction(page, "type", { element_id: "@e1", text: "x".repeat(100) })).toMatch(/^Type “x{60}” into/);
  });
});
