// Regressions from the real-site acceptance of RC2 (1f8eee4), each reproduced
// before its fix. N-numbers are the defects in ACCEPTANCE-RESULTS-1f8eee4.md.
import assert from "node:assert/strict";
import test from "node:test";
import { startApiShop } from "./fixtures/api-shop.mjs";
import { recordRun } from "./fixtures/record-run.mjs";
import { learnApiOperation, proposeCandidates } from "../src/api-engine/learn.mjs";
import { judgePageRun } from "../src/api-engine/transport.mjs";
import { callTier1, judgeObserved } from "../src/api-engine/tier1.mjs";

async function withShop(fn, state) {
  const shop = await startApiShop(state);
  try {
    await fn(shop);
  } finally {
    await shop.close();
  }
}

function refused(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail("expected learning to refuse");
}

const SIGNED_IN = [{ name: "sid", value: "valid-session-123456", domain: "127.0.0.1", path: "/" }];

/** One exchange as the extension's capture records it. */
function exchange(id, method, url, { type = "fetch", headers = {}, body, status = 200, responseHeaders = { "content-type": "application/json" }, response } = {}) {
  return {
    id,
    resource_type: type,
    request: { method, url, headers: { "user-agent": "Mozilla/5.0 fixture", ...headers }, ...(body !== undefined ? { body } : {}) },
    response: { status, headers: responseHeaders, content_type: responseHeaders["content-type"] || "", body: typeof response === "string" ? response : JSON.stringify(response ?? {}) }
  };
}

function capture(pageUrl, exchanges, { cookies = [], storage = {}, finalUrl = pageUrl } = {}) {
  return {
    capture_version: 1,
    final_url: finalUrl,
    locations: [pageUrl],
    exchanges: [exchange(1, "GET", pageUrl, { type: "document", responseHeaders: { "content-type": "text/html" }, response: "<!doctype html><title>page</title>" }), ...exchanges],
    cookies,
    storage
  };
}

// ---------------------------------------------------------------- N1 / F3

test("N1: running an operation whose answer is a whole HTML page never reports ok, and a sign-in page is auth", () =>
  withShop(async (shop) => {
    const captures = [await recordRun(shop.origin, "history", "laptops", { cookies: SIGNED_IN }), await recordRun(shop.origin, "history", "keyboards", { cookies: SIGNED_IN })];
    let learned;
    try {
      learned = learnApiOperation({ name: "history", captures, examples: [{ q: "laptops" }, { q: "keyboards" }] });
    } catch {
      return; // refused outright is fine too
    }
    const { contract } = learned;
    if (contract.response.format === "embedded" || contract.response.html) return; // a real recipe is data
    const signedIn = await callTier1(contract, { q: "monitors" }, { provided: { cookies: SIGNED_IN, storage: {} }, minIntervalMs: 0 });
    assert.equal(signedIn.ok, false, "a whole page is not data, signed in or not");
    const signedOut = await callTier1(contract, { q: "monitors" }, { provided: { cookies: [], storage: {} }, minIntervalMs: 0 });
    assert.equal(signedOut.ok, false);
  }));

test("N1: an HTML answer labelled JSON, or a sign-in page, is never ok at any tier", () => {
  const contract = learnApiOperation({
    name: "orders",
    captures: [
      capture("https://shop.example/account/orders", [exchange(2, "GET", "https://shop.example/api/orders", { headers: { referer: "https://shop.example/account/orders" }, response: { orders: [{ id: "o1", total: 5 }] } })])
    ],
    examples: [{}],
    pick_request: "GET https://shop.example/api/orders"
  }).contract;
  const login = '<!doctype html><title>Sign in</title><form action="/account/login" method="post"><input name="email"><input type="password" name="password"></form>';
  for (const tier of [1, 2, 3]) {
    const asJson = judgeObserved(contract, { status: 200, headers: { "content-type": "application/json" }, body: login, url: "https://shop.example/api/orders" }, tier);
    assert.equal(asJson.ok, false, `tier ${tier}`);
    assert.equal(asJson.class, "auth", `tier ${tier}: ${asJson.reason}`);
    const plain = judgeObserved(contract, { status: 200, headers: { "content-type": "text/html" }, body: "<!doctype html><title>Home</title><p>Welcome</p>", url: "https://shop.example/api/orders" }, tier);
    assert.equal(plain.ok, false, `tier ${tier}`);
  }
});

// ---------------------------------------------------------------- N2 / F1 in storage

test("N2: a page address (or the site's domain) the page keeps in storage is not a session value", () =>
  withShop(async (shop) => {
    const host = new URL(shop.origin).hostname;
    const storage = {
      recentlyViewed: `${shop.origin}/cart`,
      "shopify-last-page": JSON.stringify({ url: `${shop.origin}/cart`, path: "/cart" }),
      siteDomain: `.${host}`,
      // a real token the page keeps is still a session value
      authToken: "tok_9fK2mQ7xLp4Rt8Vz1Nc6"
    };
    const captures = [await recordRun(shop.origin, "cart", "for mum", { storage })];
    const { contract } = learnApiOperation({ name: "add_to_cart", captures, examples: [{ note: "for mum" }], side_effect: "write" });
    assert.equal(contract.side_effect, "write");
    assert.ok(!JSON.stringify(contract).includes("tok_9fK2mQ7xLp4Rt8Vz1Nc6"));
  }));

test("N2: a storage token in the request is still refused or kept as a reference, never as a literal", () =>
  withShop(async (shop) => {
    const token = "tok_9fK2mQ7xLp4Rt8Vz1Nc6";
    const run = await recordRun(shop.origin, "rest", "laptops", { storage: { authToken: token, recentlyViewed: `${shop.origin}/search?q=laptops` }, apiHeaders: { "x-auth-token": token } });
    const run2 = await recordRun(shop.origin, "rest", "keyboards", { storage: { authToken: token, recentlyViewed: `${shop.origin}/search?q=keyboards` }, apiHeaders: { "x-auth-token": token } });
    let outcome;
    try {
      outcome = learnApiOperation({ name: "search", captures: [run, run2], examples: [{ q: "laptops" }, { q: "keyboards" }] });
    } catch (error) {
      assert.match(error.code, /^API_LEARN_/);
      return;
    }
    assert.ok(!JSON.stringify(outcome.contract).includes(token));
  }));

// ---------------------------------------------------------------- N3

const GQL = "https://shop.example/account/customer/api/graphql";
function gqlRun({ order = ["Profile", "Orders"], storage = {} } = {}) {
  const page = "https://shop.example/account";
  const op = (id, name) =>
    exchange(id, "POST", GQL, {
      headers: { "content-type": "application/json", referer: page },
      body: JSON.stringify({ operationName: name, query: `query ${name} { customer { ${name === "Profile" ? "firstName email" : "orders(first: 5) { nodes { id } }"} } }`, variables: {} }),
      response: name === "Profile" ? { data: { customer: { firstName: "Asha", email: "a@example.test" } } } : { data: { customer: { orders: { nodes: [{ id: "gid://o/1" }, { id: "gid://o/2" }] } } } }
    });
  const extra = [exchange(2, "GET", "https://shop.example/api/config", { response: { theme: "light" } })];
  return capture(page, [...extra, ...order.map((name, index) => op(3 + index, name))], { storage });
}

test("N3: pick_request names one GraphQL operation among several on the same address", () => {
  const listed = proposeCandidates({ capture: gqlRun(), example: {} });
  const names = listed.map((item) => item.request);
  assert.ok(names.includes(`POST ${GQL} #Profile`), JSON.stringify(names));
  assert.ok(names.includes(`POST ${GQL} #Orders`), JSON.stringify(names));
  for (const wanted of ["Profile", "Orders"]) {
    // the page sends them in either order: the name decides, not the position
    for (const order of [["Profile", "Orders"], ["Orders", "Profile"]]) {
      const { contract } = learnApiOperation({ name: `my_${wanted.toLowerCase()}`, captures: [gqlRun({ order }), gqlRun({ order })], examples: [{}, {}], pick_request: `POST ${GQL} #${wanted}` });
      assert.equal(contract.match.operationName, wanted, `${wanted} in order ${order}`);
    }
  }
});

test("N3: a listed id names the same request on another run of the page", () => {
  const first = proposeCandidates({ capture: gqlRun({ order: ["Profile", "Orders"] }), example: {} });
  const second = proposeCandidates({ capture: gqlRun({ order: ["Orders", "Profile"] }), example: {} });
  const id = first.find((item) => item.request.endsWith("#Profile")).id;
  assert.equal(second.find((item) => item.id === id)?.request, `POST ${GQL} #Profile`);
  const { contract } = learnApiOperation({ name: "profile", captures: [gqlRun({ order: ["Orders", "Profile"] })], examples: [{}], pick_request: id });
  assert.equal(contract.match.operationName, "Profile");
});

test("N3: a GraphQL document the page caches in storage never becomes a session value", () => {
  const storage = { apolloCache: JSON.stringify({ query: "query Profile { customer { firstName email } }" }), lastOp: "Profile-operation" };
  const { contract } = learnApiOperation({ name: "profile", captures: [gqlRun({ storage })], examples: [{}], pick_request: `POST ${GQL} #Profile` });
  assert.deepEqual(contract.session_sources ?? [], [], JSON.stringify(contract.session_sources));
  assert.match(JSON.stringify(contract.request.body), /query Profile/);
});

// ---------------------------------------------------------------- N4

test("N4: tier 3 judges the request that carries the inputs, after a first one without them", () =>
  withShop(async (shop) => {
    const { contract } = learnApiOperation({
      name: "search",
      captures: [await recordRun(shop.origin, "rest", "laptops"), await recordRun(shop.origin, "rest", "keyboards")],
      examples: [{ q: "laptops" }, { q: "keyboards" }]
    });
    const later = await recordRun(shop.origin, "rest", "monitors");
    const api = later.exchanges.find((item) => item.request.url.includes("/api/search"));
    const empty = { ...api, id: 9, request: { ...api.request, url: api.request.url.replace("q=monitors", "q=") } };
    // only the default request so far: not drift yet, the page may still send the real one
    const early = judgePageRun(contract, { ...later, exchanges: [...later.exchanges.filter((item) => item !== api), empty] }, { q: "monitors" });
    assert.equal(early.ok, false);
    assert.equal(early.awaiting_request, true, JSON.stringify(early));
    // both: the one with the inputs answers
    const both = judgePageRun(contract, { ...later, exchanges: [...later.exchanges.filter((item) => item !== api), empty, { ...api, id: 10 }] }, { q: "monitors" });
    assert.equal(both.ok, true, both.reason);
  }));

test("N4: tier 3 tells GraphQL operations on one address apart, and a no-input read needs no inputs", () => {
  const { contract } = learnApiOperation({ name: "profile", captures: [gqlRun(), gqlRun()], examples: [{}, {}], pick_request: `POST ${GQL} #Profile` });
  for (const order of [["Profile", "Orders"], ["Orders", "Profile"]]) {
    const answer = judgePageRun(contract, gqlRun({ order }), {});
    assert.equal(answer.ok, true, `${order}: ${answer.reason}`);
    assert.deepEqual(answer.data, judgePageRun(contract, gqlRun(), {}).data);
  }
});

// ---------------------------------------------------------------- N5

test("N5: tier 3 accepts the API's load-balanced sibling host (Algolia's -dsn and -N hosts)", () => {
  const page = "https://hn.example/?q=rust";
  const run = (term, host) =>
    capture(`https://hn.example/?q=${term}`, [
      exchange(2, "POST", `https://${host}/1/indexes/Item/query`, {
        headers: { "content-type": "application/json", referer: `https://hn.example/?q=${term}` },
        body: JSON.stringify({ query: term, hitsPerPage: 5 }),
        response: { hits: [{ objectID: `${term}-1`, title: `${term} one` }, { objectID: `${term}-2`, title: `${term} two` }] }
      })
    ]);
  const { contract } = learnApiOperation({ name: "search", captures: [run("rust", "uj5wyc0l7x-dsn.algolia.net"), run("python", "uj5wyc0l7x-dsn.algolia.net")], examples: [{ q: "rust" }, { q: "python" }] });
  assert.ok(page);
  for (const host of ["uj5wyc0l7x-dsn.algolia.net", "uj5wyc0l7x-3.algolianet.com", "uj5wyc0l7x-1.algolianet.com"]) {
    const answer = judgePageRun(contract, run("golang", host), { q: "golang" });
    assert.equal(answer.ok, true, `${host}: ${answer.reason}`);
  }
  // another app's index is not a sibling
  assert.equal(judgePageRun(contract, run("golang", "zz9xyz0abc-dsn.algolia.net"), { q: "golang" }).ok, false);
});

// ---------------------------------------------------------------- N6

test("N6: learning prefers the submitted search over an autocomplete request that carries the input as well", () => {
  const run = (term) =>
    capture(`https://video.example/results?search_query=${term}`, [
      exchange(2, "POST", "https://video.example/api/search", {
        headers: { "content-type": "application/json", referer: `https://video.example/results?search_query=${term}` },
        body: JSON.stringify({ query: term }),
        response: { items: [{ id: `${term}1`, title: `${term} video` }, { id: `${term}2`, title: `${term} video 2` }] }
      }),
      // a keystroke after the search: the suggestions request comes last
      exchange(3, "GET", `https://suggest.video.example/complete/search?client=web&q=${term}`, { response: [term, [`${term} tutorial`, `${term} live`]] })
    ]);
  const { contract } = learnApiOperation({ name: "search", captures: [run("cats"), run("dogs")], examples: [{ q: "cats" }, { q: "dogs" }] });
  assert.equal(new URL(contract.request.url).pathname, "/api/search");
});

// ---------------------------------------------------------------- N8 / N9

test("N8/N9: learning names a rate limit, a challenge and a sign-in page instead of a bare failure", () => {
  const page = "https://site.example/search?q=cats";
  const rate = capture(page, [exchange(2, "GET", "https://site.example/api/search?q=cats", { status: 429, responseHeaders: { "content-type": "text/html", "retry-after": "30" }, response: "<html>Too Many Requests</html>" })]);
  const rateError = refused(() => learnApiOperation({ name: "search", captures: [rate], examples: [{ q: "cats" }] }));
  assert.equal(rateError.code, "API_LEARN_RATE_LIMITED", rateError.message);
  assert.equal(rateError.class, "rate_limited");

  const wall = capture(page, [
    exchange(2, "GET", "https://site.example/api/search?q=cats", {
      status: 403,
      responseHeaders: { "content-type": "text/html" },
      response: "<html><title>Just a moment...</title><body>cf-chl</body></html>"
    })
  ]);
  const wallError = refused(() => learnApiOperation({ name: "search", captures: [wall], examples: [{ q: "cats" }] }));
  assert.equal(wallError.code, "API_LEARN_BLOCKED", wallError.message);
  assert.equal(wallError.class, "blocked");

  const login = "https://site.example/account/login?return_to=%2Faccount";
  const signedOut = capture("https://site.example/account", [exchange(2, "GET", "https://site.example/api/config", { response: { theme: "light" } })], { finalUrl: login });
  const authError = refused(() => learnApiOperation({ name: "orders", captures: [signedOut], examples: [{}], pick_request: "GET https://site.example/api/orders" }));
  assert.equal(authError.code, "API_LEARN_AUTH", authError.message);
  assert.equal(authError.class, "auth");
});

// ---------------------------------------------------------------- N10

test("N10: a sign-in carried by a bearer token from page storage counts as signed in", () => {
  const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjdXN0b21lciJ9.c2lnbmF0dXJlMTIzNDU2";
  const run = capture("https://shop.example/account", [
    exchange(2, "GET", "https://shop.example/api/me", { headers: { authorization: `Bearer ${token}`, referer: "https://shop.example/account" }, response: { customer: { id: "c1", first_name: "Asha" } } })
  ], { storage: { customerAccessToken: token } });
  const { contract } = learnApiOperation({ name: "me", captures: [run], examples: [{}], pick_request: "GET https://shop.example/api/me" });
  assert.equal(contract.learned_logged_in, true);
  assert.ok(!JSON.stringify(contract).includes(token));
});

// ---------------------------------------------------------------- Low

test("Low: a fixed write target names its field, not an array index", () => {
  const page = "https://store.example/products/akshat-rice";
  const run = capture(page, [
    exchange(2, "POST", "https://store.example/cart/add.js", {
      headers: { "content-type": "application/json", referer: page },
      body: JSON.stringify({ items: [{ id: 92313813308, quantity: 1 }] }),
      response: { items: [{ id: 92313813308, quantity: 1, title: "Akshat (Rice)" }] }
    })
  ]);
  const { contract } = learnApiOperation({ name: "add_to_cart", captures: [run], examples: [{}], side_effect: "write", pick_request: "POST https://store.example/cart/add.js" });
  assert.equal(contract.target.kind, "fixed");
  const field = contract.target.fields.find((item) => item.value === "92313813308");
  assert.ok(field, JSON.stringify(contract.target));
  assert.equal(field.name, "id");
});

test("Low: refusing a no-input learn with nothing to choose from says so", () => {
  const empty = capture("https://site.example/account", []);
  const error = refused(() => learnApiOperation({ name: "orders", captures: [empty], examples: [{}] }));
  assert.deepEqual(error.candidates, []);
  assert.match(error.message, /no data requests|nothing to choose/i);
});
