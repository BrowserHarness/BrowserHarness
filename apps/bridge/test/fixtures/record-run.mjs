// A "run" of a fixture page recorded as the extension's network capture
// would record it: the document, then the requests its script makes, with
// real responses from the local fixture server. Stands in for the CDP
// capture in tests that do not start Chromium.

async function exchange(id, resourceType, url, init = {}) {
  const response = await fetch(url, { redirect: "manual", ...init });
  const body = await response.text();
  return {
    id,
    resource_type: resourceType,
    request: {
      method: (init.method || "GET").toUpperCase(),
      url,
      headers: { "user-agent": "Mozilla/5.0 fixture", ...(init.headers || {}) },
      ...(typeof init.body === "string" ? { body: init.body } : {})
    },
    response: {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      content_type: response.headers.get("content-type") || "",
      body
    }
  };
}

/** kind: "rest" (/search), "graphql" (/gql-search), "form" (/form-page), "cart" (a demonstrated write: a note typed on /cart, then Add). */
export async function recordRun(origin, kind, term, { queryId = "Qa1B2c3D4e5F6g7H8i9J", cookies = [], storage = {}, searchPath = "/api/search", apiHeaders = {} } = {}) {
  const page = { rest: "/search", graphql: "/gql-search", form: "/form-page", orders: "/orders", guarded: "/guarded", cart: "/cart", history: "/history" }[kind];
  const cookie = cookies.map((item) => `${item.name}=${item.value}`).join("; ");
  const pageUrl =
    kind === "cart" ? `${origin}/cart` : kind === "my-orders" ? `${origin}/account/orders` : kind === "save" ? `${origin}/watch?v=${encodeURIComponent(term)}` : `${origin}${page}?q=${encodeURIComponent(term)}`;
  const exchanges = [await exchange(1, "document", pageUrl, cookie ? { headers: { cookie } } : {})];
  exchanges.push(await exchange(2, "xhr", `${origin}/api/config`, { headers: { accept: "application/json", referer: pageUrl } }));
  if (kind === "rest") {
    exchanges.push(
      await exchange(3, "fetch", `${origin}${searchPath}?q=${encodeURIComponent(term)}&page=1&lang=en`, { headers: { accept: "application/json", referer: pageUrl, ...apiHeaders } })
    );
  } else if (kind === "history") {
    // nothing but the document carries the data
  } else if (kind === "my-orders") {
    exchanges.push(await exchange(3, "fetch", `${origin}/api/my-orders`, { headers: { accept: "application/json", referer: pageUrl, ...(cookie ? { cookie } : {}) } }));
  } else if (kind === "save") {
    // ticking "Watch later": first the panel (sent with the visitor's id), then the edit itself
    const visitor = cookies.find((item) => item.name === "VISITOR_INFO1_LIVE")?.value || "";
    exchanges.push(
      await exchange(3, "fetch", `${origin}/api/panel`, {
        method: "POST",
        headers: { "content-type": "application/json", referer: pageUrl, ...(visitor ? { "x-visitor-id": `Cgt${visitor}KJ%3D%3D` } : {}) },
        body: JSON.stringify({ context: { client: "web" }, videoIds: [term] })
      })
    );
    exchanges.push(
      await exchange(4, "fetch", `${origin}/api/playlist/edit`, {
        method: "POST",
        headers: { "content-type": "application/json", referer: pageUrl },
        body: JSON.stringify({ playlistId: "WL", actions: [{ addedVideoId: term, action: "ACTION_ADD_VIDEO" }] })
      })
    );
  } else if (kind === "orders" || kind === "guarded") {
    exchanges.push(
      await exchange(3, "fetch", `${origin}/api/${kind}?q=${encodeURIComponent(term)}`, {
        headers: {
          accept: "application/json",
          referer: pageUrl,
          ...(cookie ? { cookie } : {}),
          ...(kind === "guarded" ? { "x-page-nonce": crypto.randomUUID() } : {})
        }
      })
    );
  } else if (kind === "cart") {
    const body = JSON.stringify({ sku: "lt-1", note: term });
    exchanges.push(await exchange(3, "fetch", `${origin}/api/cart`, { method: "POST", headers: { "content-type": "application/json", referer: pageUrl }, body }));
  } else if (kind === "graphql") {
    const body = JSON.stringify({
      operationName: "SearchProducts",
      variables: { filter: { term }, first: 10 },
      extensions: { persistedQuery: { version: 1, sha256Hash: queryId } }
    });
    exchanges.push(await exchange(3, "fetch", `${origin}/graphql`, { method: "POST", headers: { "content-type": "application/json", referer: pageUrl }, body }));
  } else {
    const body = `f.req=${encodeURIComponent(JSON.stringify({ query: term, lang: "en" }))}&at=public`;
    exchanges.push(
      await exchange(3, "xhr", `${origin}/api/form-search`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", referer: pageUrl },
        body
      })
    );
  }
  return { capture_version: 1, final_url: pageUrl, locations: [pageUrl], exchanges, cookies, storage };
}
