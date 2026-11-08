// Regressions from the real-site acceptance of RC4 (e9c1b73), each reproduced
// before its fix. Defect numbers are those in ACCEPTANCE-RESULTS-e9c1b73.md.
import assert from "node:assert/strict";
import test from "node:test";
import { learnApiOperation } from "../src/api-engine/learn.mjs";
import { toCaptureResult } from "../src/api-engine/capture.mjs";
import { classifySideEffect } from "../src/api-engine/recipe.mjs";

function exchange(id, method, url, { type = "fetch", headers = {}, body, status = 200, responseHeaders = { "content-type": "application/json" }, response } = {}) {
  return {
    id,
    resource_type: type,
    request: { method, url, headers: { "user-agent": "Mozilla/5.0 fixture", ...headers }, ...(body !== undefined ? { body } : {}) },
    response: { status, headers: responseHeaders, content_type: responseHeaders["content-type"] || "", body: typeof response === "string" ? response : JSON.stringify(response ?? {}) }
  };
}

const PAGE = "https://sabpuja.example/products/akshat-rice";

/**
 * A Watch Me capture from a tab in use for a while: 500 exchanges, as the
 * extension sent them on sabpuja.com, with the demonstrated Add to cart near
 * the end (index 490 there) and the shop's analytics around it.
 */
function usedTabCapture() {
  const exchanges = [exchange(1, "GET", PAGE, { type: "document", responseHeaders: { "content-type": "text/html" }, response: "<!doctype html><title>Akshat</title>" })];
  for (let id = 2; id <= 500; id++) {
    if (id === 491) {
      exchanges.push(
        exchange(id, "POST", "https://sabpuja.example/cart/add.js", {
          headers: { "content-type": "application/json", referer: PAGE },
          body: JSON.stringify({ items: [{ id: 51620340924732, quantity: 1 }] }),
          response: { items: [{ id: 51620340924732, product_title: "Akshat", variant_title: "Rice" }] }
        })
      );
    } else {
      exchanges.push(exchange(id, "POST", `https://monorail-edge.example/v1/produce?n=${id}`, { body: JSON.stringify({ event: "page_view", n: id }), response: { ok: true } }));
    }
  }
  return { capture_version: 1, final_url: PAGE, locations: [PAGE], exchanges, cookies: [], storage: {} };
}

// ---------------------------------------------------------------- R5-1

test("R5-1: a capture over the limit keeps the newest requests, where the demonstration is", () => {
  const run = toCaptureResult(usedTabCapture());
  assert.ok(run.exchanges.length <= 400);
  assert.ok(run.exchanges.some((item) => item.request.url.endsWith("/cart/add.js")), "the demonstrated Add to cart is kept");
  assert.ok(run.exchanges.some((item) => item.resourceType === "document"), "the page load is kept");
});

test("R5-1: the demonstrated Add to cart on a used tab can be learned", () => {
  const { contract } = learnApiOperation({
    name: "add_to_cart",
    captures: [usedTabCapture()],
    examples: [{}],
    side_effect: "write",
    pick_request: "POST https://sabpuja.example/cart/add.js"
  });
  assert.equal(contract.request.url, "https://sabpuja.example/cart/add.js");
  assert.equal(contract.side_effect, "write");
});

// ---------------------------------------------------------------- R5-4: GraphQL reads

const GATEWAY = "https://learn.example/graphql-gateway?opname=Search";
const SEARCH_DOCUMENT =
  "query Search($requests: [Search_Request!]!) {\n  SearchResult {\n    search(requests: $requests) {\n      elements {\n        ...SearchProductHit\n        __typename\n      }\n      __typename\n    }\n  }\n}\n\nfragment SearchProductHit on Search_ProductHit {\n  id\n  name\n  url\n  __typename\n}\n";

function gatewayRun(q, page) {
  return {
    capture_version: 1,
    final_url: page,
    locations: [page],
    exchanges: [
      exchange(1, "GET", page, { type: "document", responseHeaders: { "content-type": "text/html" }, response: "<!doctype html><title>Search</title>" }),
      exchange(2, "POST", GATEWAY, {
        headers: { "content-type": "application/json", "operation-name": "Search", referer: page },
        body: JSON.stringify({ operationName: "Search", variables: { requests: [{ entityType: "PRODUCTS", limit: 12, query: q }] }, query: SEARCH_DOCUMENT }),
        response: {
          data: {
            SearchResult: {
              search: [{ elements: [{ id: `${q}-1`, name: `${q} for everyone`, url: `/learn/${q}-1`, __typename: "Search_ProductHit" }, { id: `${q}-2`, name: `Applied ${q}`, url: `/learn/${q}-2`, __typename: "Search_ProductHit" }] }]
            }
          }
        }
      })
    ],
    cookies: [],
    // the page's Apollo cache keeps hits by type, so a type name is also a storage value
    storage: { "search-overflow-hits": JSON.stringify({ extraHits: [{}, {}, { __typename: "Search_ProductHit" }] }) }
  };
}

test("R5-4: a GraphQL query sent as POST is learned as a read", () => {
  const { contract } = learnApiOperation({
    name: "course_search",
    captures: [gatewayRun("python", "https://learn.example/search?query=python"), gatewayRun("statistics", "https://learn.example/search?query=statistics")],
    examples: [{ q: "python" }, { q: "statistics" }],
    pick_request: "POST https://learn.example/graphql-gateway #Search"
  });
  assert.equal(contract.side_effect, "read", contract.side_effect_basis);
  assert.match(contract.side_effect_basis, /GraphQL query/);
});

test("R5-4: GraphQL classification reads the document, names and batches, not the method", () => {
  const post = (body, url = "https://x.example/graphql") => classifySideEffect({ method: "POST", url, body: JSON.stringify(body) });
  assert.equal(post({ query: "query Search { a }" }).side_effect, "read");
  assert.equal(post({ query: "{ me { id } }" }).side_effect, "read");
  assert.equal(post([{ query: "query A { a }" }, { query: "query B { b }" }]).side_effect, "read");
  assert.equal(post({ query: "fragment F on T { id }\nquery Q { ...F }" }).side_effect, "read");
  // a mutation anywhere is a write, whatever the name says
  assert.equal(post({ query: "mutation AddToCart($id: ID!) { cartAdd(id: $id) { id } }" }).side_effect, "write");
  assert.equal(post([{ query: "query A { a }" }, { query: "mutation B { b }" }]).side_effect, "write");
  // the word "mutation" inside a string argument is not a mutation
  assert.equal(post({ query: 'query Q { search(text: "mutation testing") { id } }' }).side_effect, "read");
  // persisted queries: the operation name decides, verbs at the start only
  assert.equal(post({ operationName: "AddressLookup", extensions: { persistedQuery: { sha256Hash: "a" } } }).side_effect, "read");
  assert.equal(post({ operationName: "addToCart", extensions: { persistedQuery: { sha256Hash: "a" } } }).side_effect, "write");
  assert.equal(post({ operationName: "Tracking", extensions: { persistedQuery: { sha256Hash: "a" } } }).side_effect, "unknown");
});
