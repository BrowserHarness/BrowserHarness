// Session references: a learned operation names where each credential comes
// from (a cookie, a page storage entry, a value only the page can produce),
// never the value. Values are resolved from what the extension hands over for
// one call and dropped when the call ends.

/** Upstream ref names are scoped `session:<op>/<name>`; the storage key is <name> up to its first "/" or "@". */
function storagePlace(refName, opName, storage) {
  const prefix = `${encodeURIComponent(opName)}/`;
  const rest = refName.startsWith(prefix) ? refName.slice(prefix.length) : refName;
  const bare = rest.split("@")[0];
  if (Object.hasOwn(storage, bare)) return { key: bare };
  const keys = Object.keys(storage).sort((a, b) => b.length - a.length);
  const key = keys.find((candidate) => bare.startsWith(`${candidate}/`));
  return key ? { key, path: bare.slice(key.length + 1) } : undefined;
}

/**
 * Where each ref of a learned operation comes from. `storage` is the capture's
 * page storage, read here for its keys only.
 */
export function sessionSources(refs, opName, storage = {}) {
  return refs.map((ref) => {
    if (ref.startsWith("cookie:")) return { ref, kind: "cookie", key: ref.slice(7) };
    const name = ref.slice(8);
    const place = storagePlace(name, opName, storage);
    if (place) return { ref, kind: "storage", ...place };
    // a header the page's script computes: only a page (tier 2/3) can send it
    return { ref, kind: "page" };
  });
}

function atPath(text, path) {
  if (!path) return text;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  for (const part of path.split("/")) {
    if (!value || typeof value !== "object") return undefined;
    value = value[part];
  }
  return typeof value === "string" ? value : undefined;
}

/**
 * The upstream Session for one call, from the cookies and storage the
 * extension read for it. Lists the refs that could not be filled.
 */
export function resolveSession(contract, provided = {}) {
  const cookies = Array.isArray(provided.cookies) ? provided.cookies : [];
  const storage = provided.storage && typeof provided.storage === "object" ? provided.storage : {};
  const values = {};
  const missing = [];
  for (const source of contract.session_sources || []) {
    if (source.kind === "cookie") {
      if (!cookies.some((cookie) => cookie.name === source.key)) missing.push(source.ref);
      continue;
    }
    const name = source.ref.slice(8);
    const value = source.kind === "storage" && typeof storage[source.key] === "string" ? atPath(storage[source.key], source.path) : undefined;
    if (value === undefined) missing.push(source.ref);
    else values[name] = value;
  }
  return {
    session: {
      cookies: cookies
        .filter((cookie) => cookie && typeof cookie.name === "string" && typeof cookie.value === "string")
        .map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
          domain: String(cookie.domain || ""),
          path: String(cookie.path || "/"),
          expires: typeof cookie.expires === "number" ? cookie.expires : -1,
          httpOnly: cookie.httpOnly === true,
          secure: cookie.secure === true
        })),
      values
    },
    missing,
    needs_page: (contract.session_sources || []).some((source) => source.kind === "page")
  };
}
