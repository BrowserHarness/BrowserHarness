// RC5 (R5-5 in ACCEPTANCE-RESULTS-e9c1b73.md): a Watch Me recording left on
// by accident captured a sign-in email and its emailed code as plain steps.
// What is typed there is excluded in the page, before a value is read.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isSensitiveField, isSensitiveStep, isSignInPage } from "./sensitive-input";
import { withoutSignIn } from "../background/api-watch";

describe("R5-5: Watch Me never records sign-in input", () => {
  const login = "https://shopify.example/authentication/1234/login";
  it("passwords, one-time codes and card secrets anywhere", () => {
    expect(isSensitiveField({ type: "password", url: "https://shop.example/" })).toBe(true);
    expect(isSensitiveField({ type: "text", autocomplete: "one-time-code", url: "https://shop.example/" })).toBe(true);
    expect(isSensitiveField({ type: "text", name: "verification_code", url: "https://shop.example/" })).toBe(true);
    expect(isSensitiveField({ type: "text", label: "Enter the 6-digit code we emailed", placeholder: "Sign-in code", url: "https://shop.example/" })).toBe(true);
    expect(isSensitiveField({ type: "text", autocomplete: "cc-number", url: "https://shop.example/checkout" })).toBe(true);
  });

  it("the account's email and any code box on a sign-in page", () => {
    expect(isSignInPage(login)).toBe(true);
    expect(isSensitiveField({ type: "email", name: "email", autocomplete: "email", url: login })).toBe(true);
    expect(isSensitiveField({ type: "text", inputmode: "numeric", max_length: 6, url: login })).toBe(true);
    expect(isSensitiveField({ type: "text", name: "anything", url: login })).toBe(true);
    // an email beside a password field, on a page whose address says nothing
    expect(isSensitiveField({ type: "email", name: "customer[email]", beside_secret: true, url: "https://shop.example/account" })).toBe(true);
  });

  it("an ordinary search or form field is still recorded", () => {
    expect(isSignInPage("https://sabpuja.example/products/akshat")).toBe(false);
    expect(isSensitiveField({ type: "search", name: "q", label: "Search", url: "https://sabpuja.example/search" })).toBe(false);
    expect(isSensitiveField({ type: "text", name: "quantity", url: "https://sabpuja.example/products/akshat" })).toBe(false);
    expect(isSensitiveField({ type: "text", name: "note", label: "Order note", url: "https://sabpuja.example/cart" })).toBe(false);
  });

  it("the service worker drops a typed sign-in step from an older recorder", () => {
    expect(
      isSensitiveStep({ action: "type", url: login, locator: { input_type: "email", attributes: { name: "email" } } })
    ).toBe(true);
    expect(
      isSensitiveStep({ action: "type", url: "https://shop.example/", locator: { input_type: "text", attributes: { autocomplete: "one-time-code" } } })
    ).toBe(true);
    expect(isSensitiveStep({ action: "type", url: "https://shop.example/search", locator: { input_type: "search", attributes: { name: "q" } } })).toBe(false);
    expect(isSensitiveStep({ action: "click", url: login, locator: { input_type: "email" } })).toBe(false);
  });
});

describe("R5-5: a demonstration's capture keeps nothing a sign-in step sent", () => {
  it("drops sign-in requests and what a sign-in page loaded, keeps the rest", () => {
    const exchange = (id: number, url: string, referer?: string) => ({
      id,
      resource_type: "fetch",
      request: { method: "POST", url, headers: (referer ? { Referer: referer } : {}) as Record<string, string>, body: "{}" }
    });
    const kept = withoutSignIn({
      capture_version: 1,
      final_url: "https://shop.example/my-account",
      locations: [],
      cookies: [],
      storage: {},
      exchanges: [
        exchange(1, "https://shop.example/account/login"),
        exchange(2, "https://shop.example/api/session", "https://shop.example/account/login?return_to=/"),
        exchange(3, "https://accounts.example.com/v3/signin/challenge"),
        exchange(4, "https://shop.example/cart/add.js", "https://shop.example/products/akshat")
      ]
    });
    expect(kept.exchanges.map((item) => item.id)).toEqual([4]);
  });
});

describe("the page's rules and the service worker's are the same code", () => {
  it("content/sensitive-input.ts and runtime/sensitive-input.ts match below their headers", () => {
    const code = (relative: string) => {
      const text = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
      return text.slice(text.indexOf("export interface FieldFacts"));
    };
    expect(code("../content/sensitive-input.ts")).toBe(code("./sensitive-input.ts"));
  });
});
