// Disposable, independent HTTP storefront and commerce API for RC5 acceptance.
// All accounts, session IDs and carts live in memory. No external services.
import http from "node:http";
import { randomBytes } from "node:crypto";

const random = () => randomBytes(24).toString("hex");
const html = (res, body, status = 200, headers = {}) => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
  res.end(`<!doctype html><meta charset="utf-8">${body}`);
};
const json = (res, status, value, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(value));
};
const bodyOf = async (req) => {
  let body = "";
  for await (const part of req) {
    body += part.toString("utf8");
    if (body.length > 32_768) throw new Error("request too large");
  }
  return body;
};
const listen = (server, host) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, host, () => { server.off("error", reject); resolve(server.address().port); });
});
const shut = (server) => new Promise((resolve) => server.close(() => resolve()));

export async function startCommerceAcceptanceServer() {
  const accounts = [
    { email: `lab-a-${random()}@example.invalid`, password: random(), name: "Test Customer A", orders: ["LAB-A-1001"] },
    { email: `lab-b-${random()}@example.invalid`, password: random(), name: "Test Customer B", orders: ["LAB-B-2001"] }
  ];
  const sessions = new Map();
  const state = { version: 1, writes: 0, cart: [], requests: [], accountReads: 0 };
  let origin, apiOrigin;
  const userFor = (req) => {
    const match = /(?:^|;\s*)lab_session=([a-f0-9]+)/.exec(req.headers.cookie || "");
    return sessions.get(match?.[1]);
  };
  const api = http.createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    state.requests.push({ service: "api", path, method: req.method });
    const cors = { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", vary: "Origin" };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
    if (path === `/api/${state.version === 1 ? "" : "v2/"}search` && req.method === "GET") {
      const q = new URL(req.url, "http://localhost").searchParams.get("q") || "";
      json(res, 200, { items: [{ title: `Lab product ${q}`, id: `sku-${q}` }] }, cors);
    } else if (path === "/api/search" || path === "/api/v2/search") {
      json(res, 410, { error: "endpoint moved" }, cors);
    } else if (path === "/api/cart" && req.method === "POST") {
      const input = JSON.parse(await bodyOf(req));
      if (input.sku !== "kit-1" || input.quantity !== 1) { json(res, 400, { error: "invalid item" }, cors); return; }
      state.writes += 1;
      state.cart.push({ sku: "kit-1", title: "Lab Starter Kit" });
      json(res, 200, { added: true, item_count: state.cart.length }, cors);
    } else if (path === "/api/cart" && req.method === "GET") {
      json(res, 200, { items: state.cart, item_count: state.cart.length }, cors);
    } else if (path === "/api/cart/clear" && req.method === "POST") {
      state.cart.length = 0;
      json(res, 200, { item_count: 0 }, cors);
    } else {
      json(res, 404, { error: "not found" }, cors);
    }
  });
  const site = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    state.requests.push({ service: "storefront", path: url.pathname, method: req.method });
    if (url.pathname === "/account/login" && req.method === "GET") {
      html(res, `<title>Sign in</title><h1>Sign in</h1><form method="POST"><label>Email <input id="email" name="email" type="email"></label><label>Password <input id="password" name="password" type="password"></label><button id="signin">Sign in</button></form>`);
    } else if (url.pathname === "/account/login" && req.method === "POST") {
      const form = new URLSearchParams(await bodyOf(req));
      const account = accounts.find((item) => item.email === form.get("email") && item.password === form.get("password"));
      if (!account) { html(res, "<title>Sign in</title><p>Incorrect credentials</p>", 401); return; }
      const session = random();
      sessions.set(session, account);
      res.writeHead(303, { location: "/my-account", "set-cookie": `lab_session=${session}; HttpOnly; SameSite=Lax; Path=/` });
      res.end();
    } else if (url.pathname === "/logout" && req.method === "POST") {
      const match = /(?:^|;\s*)lab_session=([a-f0-9]+)/.exec(req.headers.cookie || "");
      if (match) sessions.delete(match[1]);
      res.writeHead(303, { location: "/account/login", "set-cookie": "lab_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
      res.end();
    } else if (url.pathname === "/my-account") {
      if (!userFor(req)) { res.writeHead(302, { location: "/account/login" }); res.end(); return; }
      html(res, `<title>My account</title><h1>My account</h1><ul id="orders"></ul><form action="/logout" method="POST"><button id="logout">Sign out</button></form><script>fetch('/api/my-account').then(r=>r.json()).then(data=>{ for (const id of data.orders || []) { const li=document.createElement('li'); li.textContent=id; document.querySelector('#orders').append(li); } });</script>`);
    } else if (url.pathname === "/api/my-account") {
      const user = userFor(req);
      if (!user) { json(res, 401, { error: "Please sign in", require_login: true }); return; }
      state.accountReads += 1;
      json(res, 200, { name: user.name, orders: user.orders });
    } else if (url.pathname === "/search") {
      const q = url.searchParams.get("q") || "";
      html(res, `<title>Product search</title><h1>Search products</h1><ul id="results"></ul><script>const q=new URLSearchParams(location.search).get('q'); if(q) fetch(${JSON.stringify(apiOrigin)}+'/api/${state.version === 1 ? "" : "v2/"}search?q='+encodeURIComponent(q)).then(r=>r.json()).then(data=>{for (const p of data.items || []) {const li=document.createElement('li'); li.textContent=p.title; document.querySelector('#results').append(li);}});</script>`);
    } else if (url.pathname === "/products/kit") {
      html(res, `<title>Lab Starter Kit</title><h1>Lab Starter Kit</h1><button id="add">Add to cart</button><p id="done"></p><script>document.querySelector('#add').onclick=()=>fetch(${JSON.stringify(apiOrigin)}+'/api/cart',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sku:'kit-1',quantity:1})}).then(r=>r.json()).then(data=>{document.querySelector('#done').textContent=data.added?'Added':'Failed'});</script>`);
    } else if (url.pathname === "/cart") {
      html(res, `<title>Your cart</title><h1>Cart</h1><p id="count"></p><script>fetch(${JSON.stringify(apiOrigin)}+'/api/cart').then(r=>r.json()).then(data=>{document.querySelector('#count').textContent=String(data.item_count)});</script>`);
    } else { html(res, "<title>Not found</title>", 404); }
  });
  await listen(api, "localhost");
  apiOrigin = `http://localhost:${api.address().port}`;
  await listen(site, "127.0.0.1");
  origin = `http://127.0.0.1:${site.address().port}`;
  return {
    origin, apiOrigin, accounts, state,
    close: async () => { await Promise.all([shut(site), shut(api)]); sessions.clear(); }
  };
}
