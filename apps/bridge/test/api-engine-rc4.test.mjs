// Regressions from the real-site acceptance of RC3 (58b154c), each reproduced
// before its fix. Defect numbers are those in ACCEPTANCE-RESULTS-58b154c.md.
import assert from "node:assert/strict";
import test from "node:test";
import { learnApiOperation } from "../src/api-engine/learn.mjs";

/** One exchange as the extension's capture records it. */
function exchange(id, method, url, { type = "fetch", headers = {}, body, status = 200, responseHeaders = { "content-type": "application/json" }, response } = {}) {
  return {
    id,
    resource_type: type,
    request: { method, url, headers: { "user-agent": "Mozilla/5.0 fixture", ...headers }, ...(body !== undefined ? { body } : {}) },
    response: { status, headers: responseHeaders, content_type: responseHeaders["content-type"] || "", body: typeof response === "string" ? response : JSON.stringify(response ?? {}) }
  };
}

function capture(pageUrl, exchanges) {
  return {
    capture_version: 1,
    final_url: pageUrl,
    locations: [pageUrl],
    exchanges: [exchange(1, "GET", pageUrl, { type: "document", responseHeaders: { "content-type": "text/html" }, response: "<!doctype html><title>Akshat</title>" }), ...exchanges],
    cookies: [],
    storage: {}
  };
}

const BOUNDARY = "----WebKitFormBoundaryq8Zt3RkW1fYvB2xA";

/** A Shopify theme's product form, as Chrome sends it: multipart/form-data. */
function multipart(fields) {
  return `${Object.entries(fields)
    .map(([name, value]) => `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    .join("")}--${BOUNDARY}--\r\n`;
}

const PAGE = "https://sabpuja.example/products/akshat";

function shopifyAdd() {
  return capture(PAGE, [
    exchange(2, "POST", "https://sabpuja.example/cart/add", {
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}`, accept: "application/javascript", "x-requested-with": "XMLHttpRequest", referer: PAGE },
      body: multipart({
        form_type: "product",
        utf8: "✓",
        id: "44012345678901",
        quantity: "1",
        "product-id": "8123456789012",
        "section-id": "template--19283746__main",
        sections: "cart-notification-product,cart-notification-button,cart-icon-bubble",
        sections_url: "/products/akshat"
      }),
      response: { id: 44012345678901, quantity: 1, product_title: "Akshat", variant_title: "Rice", title: "Akshat - Rice", handle: "akshat", sections: { "cart-icon-bubble": "<div>1</div>" } }
    })
  ]);
}

// ---------------------------------------------------------------- defect 2

test("2: a multipart/form-data write names the item it acts on", () => {
  const { contract } = learnApiOperation({ name: "add_to_cart", captures: [shopifyAdd()], examples: [{}], side_effect: "write", pick_request: "POST https://sabpuja.example/cart/add" });
  assert.equal(contract.side_effect, "write");
  assert.equal(contract.target.kind, "fixed");
  const id = contract.target.fields.find((field) => field.value === "44012345678901");
  assert.ok(id, `the variant id is named: ${JSON.stringify(contract.target)}`);
  assert.equal(id.name, "id");
  assert.ok(contract.target.fields.some((field) => field.name === "product-id" && field.value === "8123456789012"));
  // a form's bookkeeping is not an item
  assert.ok(!contract.target.fields.some((field) => /sections|form_type|utf8/.test(field.name)), JSON.stringify(contract.target.fields));
  // the site's own words for it, from the learned answer
  assert.match(contract.target.label ?? "", /Akshat/);
  assert.match(contract.target.label ?? "", /Rice/);
});

test("2: a urlencoded form write names its item too", () => {
  const run = capture(PAGE, [
    exchange(2, "POST", "https://sabpuja.example/cart/add", {
      headers: { "content-type": "application/x-www-form-urlencoded", referer: PAGE },
      body: "form_type=product&utf8=%E2%9C%93&id=44012345678901&quantity=1",
      response: { id: 44012345678901, product_title: "Akshat", variant_title: "Rice" }
    })
  ]);
  const { contract } = learnApiOperation({ name: "add_to_cart", captures: [run], examples: [{}], side_effect: "write", pick_request: "POST https://sabpuja.example/cart/add" });
  assert.ok(contract.target.fields.some((field) => field.name === "id" && field.value === "44012345678901"), JSON.stringify(contract.target));
});

// ---------------------------------------------------------------- defect 4 (P0)

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjdXN0b21lciJ9.c2lnbmF0dXJlMTIzNDU2";

/** A search page whose data request carries a session value from page storage. */
function tokenSearch(id, q) {
  const page = `https://data.example/search?q=${q}`;
  return {
    ...capture(page, [
      exchange(id, "GET", `https://data.example/api/search?q=${q}&limit=20`, {
        headers: { authorization: `Bearer ${TOKEN}`, referer: page },
        response: { results: [{ key: `${q}-1`, name: `${q} one` }, { key: `${q}-2`, name: `${q} two` }] }
      })
    ]),
    storage: { accessToken: TOKEN }
  };
}

test("4: tier 3 accepts the page's own request when the operation holds a session value", async () => {
  const { judgePageRun } = await import("../src/api-engine/transport.mjs");
  const { contract } = learnApiOperation({ name: "search", captures: [tokenSearch(2, "puma"), tokenSearch(2, "lynx")], examples: [{ q: "puma" }, { q: "lynx" }] });
  assert.ok(JSON.stringify(contract.slots).includes("ref"), `the token is a session reference: ${JSON.stringify(contract.slots)}`);
  assert.ok(!JSON.stringify(contract).includes(TOKEN));
  const page = tokenSearch(7, "ocelot");
  const judged = judgePageRun(contract, page, { q: "ocelot" });
  assert.equal(judged.class, "ok", JSON.stringify(judged));
  assert.equal(judged.ok, true);
  // another input still is not this request
  const other = judgePageRun(contract, page, { q: "jaguar" });
  assert.equal(other.ok, false);
});

// ---------------------------------------------------------------- P1: 429 while learning

function refused(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail("expected learning to refuse");
}

test("P1: a 429 during learning is reported as rate limited, whatever its body", () => {
  const page = (q) => `https://registry.example/search?q=${q}`;
  const limited = (q, response, contentType) =>
    capture(page(q), [exchange(2, "GET", `https://registry.example/search/api?q=${q}`, { status: 429, responseHeaders: { "content-type": contentType, "retry-after": "60" }, response })]);
  for (const [response, type] of [[{ message: "Too many requests" }, "application/json"], ["", "text/plain"], ["Too many requests, slow down", "text/plain"]]) {
    const error = refused(() => learnApiOperation({ name: "search", captures: [limited("react", response, type)], examples: [{ q: "react" }] }));
    assert.equal(error.code, "API_LEARN_RATE_LIMITED", `${type}: ${error.code} ${error.message}`);
  }
  // the second example's run was limited
  const ok = capture(page("react"), [exchange(2, "GET", "https://registry.example/search/api?q=react", { response: { objects: [{ package: { name: "react" } }] } })]);
  const error = refused(() => learnApiOperation({ name: "search", captures: [ok, limited("vue", { message: "Too many requests" }, "application/json")], examples: [{ q: "react" }, { q: "vue" }] }));
  assert.equal(error.code, "API_LEARN_RATE_LIMITED", `${error.code} ${error.message}`);
});
