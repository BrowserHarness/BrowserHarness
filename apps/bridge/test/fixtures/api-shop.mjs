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

    // the page that shows that list: it takes no input
    if (url.pathname === "/account/orders") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>Your orders</title><ul id="orders"></ul>
<script>
fetch("/api/config", { headers: { accept: "application/json" } });
fetch("/api/my-orders", { headers: { accept: "application/json" }, credentials: "same-origin" })
  .then((r) => r.json()).then((data) => {
    for (const item of data.orders || []) { const li = document.createElement("li"); li.textContent = item.id; document.getElementById("orders").append(li); }
  });
</script>`);
      return;
    }

    // a signed-in list with no input (a customer account's orders)
    if (url.pathname === "/api/my-orders") {
      if (!/(?:^|;\s*)sid=valid-session-123456/.test(req.headers.cookie || "")) {
        json(401, { error: "Please sign in", require_login: true });
        return;
      }
      json(200, { orders: [{ id: "o1", total: 42 }, { id: "o2", total: 17 }] });
      return;
    }

    // a page's side request that sends the visitor's id beside other text, as YouTube's get_panel does
    if (url.pathname === "/api/panel" && req.method === "POST") {
      let videoIds = [];
      try {
        videoIds = JSON.parse(body).videoIds || [];
      } catch {}
      json(200, { panel: { title: "Save to...", videoIds, playlists: [{ id: "WL", title: "Watch later" }, { id: "LL", title: "Liked" }] } });
      return;
    }

    // a video page with a "Watch later" checkbox: ticking it saves this page's video
    if (url.pathname === "/watch") {
      const v = url.searchParams.get("v") || "";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>Video ${v.replace(/[<&"]/g, "")}</title><label><input type="checkbox" id="later"> Watch later</label><p id="saved"></p>
<script>
const v = new URLSearchParams(location.search).get("v");
document.getElementById("later").addEventListener("change", () => {
  fetch("/api/panel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ context: { client: "web" }, videoIds: [v] }) })
    .then(() => fetch("/api/playlist/edit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ playlistId: "WL", actions: [{ addedVideoId: v, action: "ACTION_ADD_VIDEO" }] }) }))
    .then((r) => r.json()).then(() => { document.getElementById("saved").textContent = "Saved"; });
});
</script>`);
      return;
    }

    // a checkbox write: no typed input, the video is in the page
    if (url.pathname === "/api/playlist/edit" && req.method === "POST") {
      json(200, { status: "STATUS_SUCCEEDED" });
      return;
    }

    // a page that renders its data into the document (YouTube history, AniList's first load)
    if (url.pathname === "/history") {
      const q = url.searchParams.get("q") || "";
      const signedIn = /(?:^|;\s*)sid=valid-session-123456/.test(req.headers.cookie || "");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>History</title><input name="q" value="${q.replace(/"/g, "&quot;")}">${signedIn ? `<script>var initialData = ${JSON.stringify({ items: catalog(q) })};</script>` : "<a href=/login>Sign in</a>"}`);
      return;
    }

    if (url.pathname === "/api/cart" && req.method === "POST") {
      // acceptWithoutChange: a 2xx that changes nothing (a write that silently did not happen)
      if (state.acceptWithoutChange) {
        state.unappliedWrites = (state.unappliedWrites || 0) + 1;
        json(200, { ok: true, cart_size: state.writes, items: [] });
        return;
      }
      state.writes += 1;
      let note = "";
      try {
        note = String(JSON.parse(body).note || "");
      } catch {}
      json(200, { ok: true, cart_size: state.writes, items: [{ sku: "lt-1", note }] });
      return;
    }

    // a write a person demonstrates: a note typed, then Add
    if (url.pathname === "/cart") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>Cart</title><label>Gift note <input id="note" name="note"></label><button id="add" type="button">Add to cart</button><p id="done"></p>
<script>
document.getElementById("add").addEventListener("click", () => {
  fetch("/api/cart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sku: "lt-1", note: document.getElementById("note").value }) })
    .then((r) => r.json()).then((data) => { document.getElementById("done").textContent = "Added (" + data.cart_size + ")"; });
});
</script>`);
      return;
    }

    // a write the server takes and then drops the connection on: did it happen?
    if (url.pathname === "/api/hangup") {
      state.writes += 1;
      req.socket.destroy();
      return;
    }

    // A Shopify-like product page (RC3: sabpuja.com). Its theme sends Add to
    // cart as multipart/form-data, and the cart lives behind the "cart" cookie:
    // an add without it lands in a new, empty-handed cart nobody sees.
    const cookieCart = /(?:^|;\s*)cart=([^;]+)/.exec(req.headers.cookie || "")?.[1];
    if (url.pathname === "/products/akshat") {
      const headers = { "content-type": "text/html; charset=utf-8" };
      if (!cookieCart) headers["set-cookie"] = `cart=c${Math.random().toString(36).slice(2, 12)}; Path=/; SameSite=Lax`;
      res.writeHead(200, headers);
      res.end(`<!doctype html><title>Akshat – Sabpuja</title><h1>Akshat</h1>
<form id="product-form" action="/cart/add" method="post" enctype="multipart/form-data">
<input type="hidden" name="form_type" value="product"><input type="hidden" name="utf8" value="✓">
<label>Variant <select name="id"><option value="44012345678901">Rice</option></select></label>
<input type="hidden" name="quantity" value="1"><input type="hidden" name="product-id" value="8123456789012">
<input type="hidden" name="section-id" value="template--19283746__main">
<button id="add" type="submit">Add to cart</button></form><p id="done"></p><p id="busy"></p>
<script>
// ?busy=N: a tab in use for a while (RC4: analytics had sent hundreds of requests before Record)
(async () => {
  const busy = Number(new URLSearchParams(location.search).get("busy") || 0);
  for (let i = 0; i < busy; i += 20) {
    await Promise.all(Array.from({ length: Math.min(20, busy - i) }, (_, k) => fetch("/beacon?n=" + (i + k), { method: "POST", body: "event=page_view" })));
  }
  if (busy) document.getElementById("busy").textContent = "sent " + busy;
})();
document.getElementById("product-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const body = new FormData(event.target);
  body.append("sections", "cart-notification-product,cart-icon-bubble");
  body.append("sections_url", location.pathname);
  fetch("/cart/add", { method: "POST", headers: { accept: "application/javascript", "x-requested-with": "XMLHttpRequest" }, body })
    .then((r) => r.json()).then((data) => { document.getElementById("done").textContent = "Added " + data.title; });
});
</script>`);
      return;
    }
    if (url.pathname === "/beacon") {
      res.writeHead(204);
      res.end();
      return;
    }

    // A customer account like Shopify's (RC4): signed out, the page goes to
    // the sign-in page; signed in, the page sends a token from its own storage.
    const signedIn = /(?:^|;\s*)acct=signed-in-7Qp2/.test(req.headers.cookie || "");
    if (url.pathname === "/my-account") {
      if (!signedIn) {
        res.writeHead(302, { location: "/account/login?return_to=/my-account" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>Your account</title><ul id="orders"></ul>
<script>
fetch("/api/my-account?view=orders", { headers: { accept: "application/json", authorization: "Bearer " + localStorage.getItem("acctToken") } })
  .then((r) => r.json()).then((data) => {
    for (const item of data.orders || []) { const li = document.createElement("li"); li.textContent = item.id; document.getElementById("orders").append(li); }
  });
</script>`);
      return;
    }
    if (url.pathname === "/api/my-account") {
      if (!signedIn || req.headers.authorization !== "Bearer acct_tok_Zr81kLm2Qw") {
        json(401, { error: "Please sign in" });
        return;
      }
      json(200, { orders: [{ id: "#1001", total: 42 }, { id: "#1002", total: 17 }] });
      return;
    }
    // the sign-in step: an email, a password and an emailed one-time code
    if (url.pathname === "/account/login" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>Sign in – Sabpuja</title><h1>Sign in</h1>
<form id="login">
<label>Email <input id="email" type="email" name="customer[email]" autocomplete="email"></label>
<label>Password <input id="password" type="password" name="customer[password]" autocomplete="current-password"></label>
<label>Code we emailed you <input id="code" type="text" name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></label>
<label>Full name <input id="fullname" type="text" name="customer[name]"></label>
<button id="signin" type="submit">Sign in</button></form><p id="done"></p>
<script>
document.getElementById("login").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  fetch("/account/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(form)) })
    .then((r) => r.json()).then((data) => {
      if (data.token) localStorage.setItem("acctToken", data.token);
      document.getElementById("done").textContent = data.ok ? "Signed in" : "Try again";
      if (data.ok) setTimeout(() => location.assign("/my-account"), 300);
    });
});
</script>`);
      return;
    }
    if (url.pathname === "/account/login" && req.method === "POST") {
      json(200, { ok: true, token: "acct_tok_Zr81kLm2Qw" }, { "set-cookie": "acct=signed-in-7Qp2; Path=/; SameSite=Lax" });
      return;
    }

    if (url.pathname === "/cart/add" && req.method === "POST") {
      const boundary = /boundary=([^;]+)/.exec(req.headers["content-type"] || "")?.[1];
      const fields = {};
      if (boundary) {
        for (const part of body.split(`--${boundary}`)) {
          const name = /name="([^"]+)"/.exec(part)?.[1];
          const at = part.indexOf("\r\n\r\n");
          if (name && at >= 0) fields[name] = part.slice(at + 4).replace(/\r\n$/, "");
        }
      } else {
        for (const [key, value] of new URLSearchParams(body)) fields[key] = value;
      }
      if (fields.id !== "44012345678901") {
        json(422, { status: 422, message: "Cart Error", description: "Cannot find variant" });
        return;
      }
      state.carts ??= new Map();
      state.cartAdds = (state.cartAdds || 0) + 1;
      const token = cookieCart || `orphan${state.cartAdds}`;
      if (!cookieCart) state.orphanAdds = (state.orphanAdds || 0) + 1;
      const items = state.carts.get(token) || [];
      items.push({ id: Number(fields.id), quantity: Number(fields.quantity || 1), product_title: "Akshat", variant_title: "Rice" });
      state.carts.set(token, items);
      json(200, { id: Number(fields.id), quantity: Number(fields.quantity || 1), product_title: "Akshat", variant_title: "Rice", title: "Akshat - Rice", handle: "akshat", sections: { "cart-icon-bubble": `<span>${items.length}</span>` } });
      return;
    }
    if (url.pathname === "/cart.js") {
      const items = (state.carts?.get(cookieCart) || []);
      json(200, { token: cookieCart ? "present" : "none", item_count: items.reduce((sum, item) => sum + item.quantity, 0), items });
      return;
    }
    if (url.pathname === "/cart/clear.js" && req.method === "POST") {
      state.carts?.delete(cookieCart);
      json(200, { item_count: 0, items: [] });
      return;
    }

    // A signed-in search whose page sends a token from its own storage and a
    // fresh one-time value, a moment after it loads (RC3: GBIF, Algolia and
    // signed-in Shopify reads). Only the page itself can send it: tier 3.
    if (url.pathname === "/token-search") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>Records</title><ul id="results"></ul>
<script>
const q = new URLSearchParams(location.search).get("q");
setTimeout(() => {
  if (q) fetch("/api/token-search?q=" + encodeURIComponent(q) + "&limit=20", { headers: { accept: "application/json", authorization: "Bearer " + localStorage.getItem("authToken"), "x-page-nonce": crypto.randomUUID() } })
    .then((r) => r.json()).then((data) => {
      for (const item of data.results || []) { const li = document.createElement("li"); li.textContent = item.title; document.getElementById("results").append(li); }
    });
}, 1200);
</script>`);
      return;
    }
    if (url.pathname === "/api/token-search") {
      const nonce = String(req.headers["x-page-nonce"] || "");
      state.nonces ??= new Set();
      if (req.headers.authorization !== "Bearer tok_9fK2mQ7vX1pL8sD4hJ6w") {
        json(401, { error: "Please sign in" });
        return;
      }
      if (!/^[0-9a-f-]{36}$/.test(nonce) || state.nonces.has(nonce)) {
        json(403, { error: "request signature rejected" });
        return;
      }
      state.nonces.add(nonce);
      json(200, { results: catalog(url.searchParams.get("q")), count: catalog(url.searchParams.get("q")).length });
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
