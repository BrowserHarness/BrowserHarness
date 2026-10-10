// A small local website with JSON endpoints, used by the API engine tests.
// Nothing here reaches the internet.
import http from "node:http";

const CATALOG = {
  laptops: [
    { id: "l1", title: "Aero 14 laptop", price: 899 },
    { id: "l2", title: "Book Pro laptop", price: 1299 }
  ],
  keyboards: [
    { id: "k1", title: "Clicky keyboard", price: 79 },
    { id: "k2", title: "Quiet keyboard", price: 59 }
  ],
  monitors: [
    { id: "m1", title: "27 inch monitor", price: 249 },
    { id: "m2", title: "34 inch ultrawide monitor", price: 499 }
  ],
  tablets: [{ id: "t1", title: "Slate tablet", price: 329 }]
};

export function catalog(term) {
  return CATALOG[String(term || "").toLowerCase()] || [];
}

/**
 * options.state is shared with the test so it can change the site under the
 * engine: rotate a GraphQL query id, move an endpoint, rename a field, limit rate.
 */
export async function startApiShop(state = {}) {
  state.queryId ??= "Qa1B2c3D4e5F6g7H8i9J";
  state.searchPath ??= "/api/search";
  state.field ??= "items";
  state.requests = [];
  state.writes = 0;
  state.rateLimitRemaining ??= Infinity;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://shop.local");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    state.requests.push({ method: req.method, path: url.pathname, search: url.search, body, cookie: req.headers.cookie || "" });
    const json = (status, value, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
      res.end(JSON.stringify(value));
    };

    if (state.rateLimitRemaining <= 0 && url.pathname.startsWith("/api/")) {
      json(429, { error: "rate limit exceeded, please wait" }, { "retry-after": "30" });
      return;
    }
    if (url.pathname.startsWith("/api/")) state.rateLimitRemaining -= 1;

    if (url.pathname === "/" || url.pathname === "/search") {
      const q = url.searchParams.get("q") || "";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>Shop</title><form action="/search"><input name="q" aria-label="Search" value="${q.replace(/"/g, "&quot;")}"><button>Search</button></form>
<ul id="results"></ul>
<script>
const q = new URLSearchParams(location.search).get("q");
if (q) fetch(${JSON.stringify(state.searchPath)} + "?q=" + encodeURIComponent(q) + "&page=1&lang=en", { headers: { accept: "application/json" } })
  .then((r) => r.json()).then((data) => {
    for (const item of data[${JSON.stringify(state.field)}] || []) {
      const li = document.createElement("li"); li.textContent = item.title; document.getElementById("results").append(li);
    }
  });
</script>`);
      return;
    }

    if (url.pathname === "/gql-search" || url.pathname === "/form-page") {
      const graph = url.pathname === "/gql-search";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>Shop</title><ul id="results"></ul>
<script>
const q = new URLSearchParams(location.search).get("q");
const req = ${graph
        ? `fetch("/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationName: "SearchProducts", variables: { filter: { term: q }, first: 10 }, extensions: { persistedQuery: { version: 1, sha256Hash: ${JSON.stringify(state.queryId)} } } }) })`
        : `fetch("/api/form-search", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: "f.req=" + encodeURIComponent(JSON.stringify({ query: q, lang: "en" })) + "&at=public" })`};
if (q) req.then((r) => r.json()).then((data) => {
  const items = (data.data && data.data.search.products) || data.results || [];
  for (const item of items) { const li = document.createElement("li"); li.textContent = item.name || item.title; document.getElementById("results").append(li); }
});
</script>`);
      return;
    }

    // a signed-in page: its API answers only with the session cookie
    if (url.pathname === "/orders" || url.pathname === "/guarded") {
      const api = url.pathname === "/orders" ? "/api/orders" : "/api/guarded";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>Shop</title><ul id="results"></ul>
<script>
const q = new URLSearchParams(location.search).get("q");
// /guarded: a one-time value made fresh by each page load, as anti-bot scripts do
const headers = ${url.pathname === "/guarded" ? '{ accept: "application/json", "x-page-nonce": crypto.randomUUID() }' : '{ accept: "application/json" }'};
if (q) fetch(${JSON.stringify(api)} + "?q=" + encodeURIComponent(q), { headers, credentials: "same-origin" })
  .then((r) => r.json()).then((data) => {
    for (const item of data.results || []) { const li = document.createElement("li"); li.textContent = item.title; document.getElementById("results").append(li); }
  });
</script>`);
      return;
    }

    if (url.pathname === "/api/orders") {
      if (!/(?:^|;\s*)sid=valid-session-123456/.test(req.headers.cookie || "")) {
        json(401, { error: "Please sign in", require_login: true });
        return;
      }
      json(200, { results: catalog(url.searchParams.get("q")).map((item) => ({ ...item, ordered: true })) });
      return;
    }

    if (url.pathname === "/api/guarded") {
      const nonce = String(req.headers["x-page-nonce"] || "");
      state.nonces ??= new Set();
      if (!/^[0-9a-f-]{36}$/.test(nonce) || state.nonces.has(nonce)) {
        json(403, { error: "request signature rejected" });
        return;
      }
      state.nonces.add(nonce);
      json(200, { results: catalog(url.searchParams.get("q")) });
      return;
    }

    if (url.pathname === "/api/config") {
      json(200, { theme: "light", build: "2026.10.1", features: ["search"] });
      return;
    }

    if (url.pathname === state.searchPath && req.method === "GET") {
      const q = url.searchParams.get("q");
      if (!q) {
        json(400, { error: "q is required" });
        return;
      }
      json(200, { [state.field]: catalog(q), page: Number(url.searchParams.get("page") || 1), took_ms: 3 });
      return;
    }

    if (url.pathname === "/graphql" && req.method === "POST") {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        json(400, { errors: [{ message: "bad json" }] });
        return;
      }
      if (parsed.extensions?.persistedQuery?.sha256Hash !== state.queryId && parsed.queryId !== state.queryId) {
        json(200, { errors: [{ message: "PersistedQueryNotFound" }], data: null });
        return;
      }
      const term = parsed.variables?.filter?.term;
      json(200, { data: { search: { products: catalog(term).map(({ id, title, price }) => ({ id, name: title, price })) } } });
      return;
    }

    if (url.pathname === "/api/form-search" && req.method === "POST") {
      const params = new URLSearchParams(body);
      let inner = {};
      try {
        inner = JSON.parse(params.get("f.req") || "{}");
      } catch {
        json(400, { error: "bad f.req" });
        return;
      }
      json(200, { results: catalog(inner.query) });
      return;
    }

    if (url.pathname === "/api/account") {
      if (!/(?:^|;\s*)sid=valid-session-123456/.test(req.headers.cookie || "")) {
        json(401, { error: "Please sign in", require_login: true });
        return;
      }
      json(200, { account: { name: "Ada", orders: 3 } });
      return;
    }

    if (url.pathname === "/api/cart" && req.method === "POST") {
      state.writes += 1;
      json(200, { ok: true, cart_size: state.writes });
      return;
    }

    if (url.pathname === "/challenge") {
      res.writeHead(403, { "content-type": "text/html" });
      res.end("<html><title>Just a moment...</title><body>Checking your browser before accessing. cf-chl</body></html>");
      return;
    }

    json(404, { error: "not found" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    state,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/** An API Anything site spec for the fixture, as upstream's `add` would write it. */
export function shopSiteSpec(origin) {
  return {
    name: "fixture-shop",
    displayName: "Fixture shop",
    baseUrl: origin,
    description: "Local test shop",
    loginCookies: ["sid"],
    operations: [
      {
        name: "search",
        description: "Search products",
        request: {
          method: "GET",
          url: `${origin}/api/search?q=laptops&page=1&lang=en`,
          headers: { accept: "application/json" }
        },
        slots: [{ param: "q", at: ["query:q"] }],
        trigger: { url: `${origin}/search?q={q}` },
        match: { method: "GET", host: new URL(origin).host, path: "/api/search" },
        response: { format: "json", extract: "items", pick: ["title", "price"] },
        params: [{ name: "q", type: "string", required: true, example: "laptops" }],
        readOnly: true
      },
      {
        name: "account",
        description: "The signed-in account",
        request: { method: "GET", url: `${origin}/api/account`, headers: { accept: "application/json" } },
        slots: [],
        trigger: { url: `${origin}/` },
        match: { method: "GET", path: "/api/account" },
        response: { format: "json", extract: "account" },
        params: [],
        readOnly: true,
        learnedLoggedIn: true
      },
      {
        name: "addToCart",
        description: "Add a product to the cart",
        request: {
          method: "POST",
          url: `${origin}/api/cart`,
          headers: { "content-type": "application/json" },
          body: '{"id":"l1"}'
        },
        slots: [{ param: "id", at: ["body", "json:/id"] }],
        trigger: { url: `${origin}/` },
        match: { method: "POST", path: "/api/cart" },
        response: { format: "json" },
        params: [{ name: "id", type: "string", required: true, example: "l1" }],
        readOnly: false
      }
    ]
  };
}
