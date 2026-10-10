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

/** kind: "rest" (/search), "graphql" (/gql-search), "form" (/form-page). */
export async function recordRun(origin, kind, term, { queryId = "Qa1B2c3D4e5F6g7H8i9J", cookies = [], storage = {}, searchPath = "/api/search", apiHeaders = {} } = {}) {
  const page = { rest: "/search", graphql: "/gql-search", form: "/form-page" }[kind];
  const pageUrl = `${origin}${page}?q=${encodeURIComponent(term)}`;
  const exchanges = [await exchange(1, "document", pageUrl)];
  exchanges.push(await exchange(2, "xhr", `${origin}/api/config`, { headers: { accept: "application/json", referer: pageUrl } }));
  if (kind === "rest") {
    exchanges.push(
      await exchange(3, "fetch", `${origin}${searchPath}?q=${encodeURIComponent(term)}&page=1&lang=en`, { headers: { accept: "application/json", referer: pageUrl, ...apiHeaders } })
    );
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
