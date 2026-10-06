// The setup page: after a double-click install, the helper app opens this
// page in the browser so pairing needs no terminal. It runs only while the
// installer window is open, on 127.0.0.1, behind a random secret path, and
// talks to the helper app as a local program (with its token), so the helper
// app itself still refuses web pages.
import crypto from "node:crypto";
import http from "node:http";

const PAGE_TITLE = "Set up the BrowserHarness helper app";

/**
 * @param {{
 *   status: () => Promise<{ running: boolean, extension_connected?: boolean, starts_at_login?: boolean, agents?: { name: string, status: string }[] }>,
 *   approve: (code: string) => Promise<{ ok: boolean, code?: string, message?: string }>,
 *   secret?: string
 * }} options
 */
export function createSetupServer({ status, approve, secret = crypto.randomBytes(24).toString("hex") }) {
  let port = 0;
  let lastSeen = Date.now();
  const base = `/${secret}/`;

  const send = (res, code, type, body) => {
    res.writeHead(code, {
      "content-type": type,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY"
    });
    res.end(body);
  };
  const json = (res, code, value) => send(res, code, "application/json", JSON.stringify(value));

  const server = http.createServer(async (req, res) => {
    try {
      // Only this exact address, so another website can't reach the page by a
      // name that points at this computer.
      const host = `127.0.0.1:${port}`;
      if (req.headers.host !== host) return send(res, 421, "text/plain", "Wrong address");
      if (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`) {
        return send(res, 403, "text/plain", "Not allowed");
      }
      const url = new URL(req.url || "/", `http://${host}`);
      if (!url.pathname.startsWith(base)) return send(res, 404, "text/plain", "Not found");
      const route = url.pathname.slice(base.length);
      lastSeen = Date.now();

      if (req.method === "GET" && route === "") return send(res, 200, "text/html; charset=utf-8", PAGE_HTML);
      if (req.method === "GET" && route === "status") return json(res, 200, await status());
      if (req.method === "POST" && route === "pair") {
        if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
          return send(res, 415, "text/plain", "JSON only");
        }
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 1024) return send(res, 413, "text/plain", "Too big");
        }
        const code = String(JSON.parse(raw || "{}").code || "").replace(/\D/g, "");
        if (code.length !== 6) {
          return json(res, 200, { ok: false, code: "BAD_CODE", message: "The code has 6 numbers. Check you typed all of them." });
        }
        return json(res, 200, await approve(code));
      }
      send(res, 404, "text/plain", "Not found");
    } catch (error) {
      json(res, 500, { ok: false, code: "SETUP_ERROR", message: error instanceof Error ? error.message : String(error) });
    }
  });

  return {
    server,
    /** Seconds since the page last asked for anything. */
    idleSeconds: () => (Date.now() - lastSeen) / 1000,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      port = server.address().port;
      return `http://127.0.0.1:${port}${base}`;
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // The open page keeps a connection alive; end it too.
        server.closeAllConnections();
      })
  };
}

/** Plain words for what the helper app said when a code didn't work. */
export function pairingMessage(result) {
  if (result?.ok) return { ok: true };
  const code = result?.error?.code || result?.code;
  if (code === "PAIRING_CODE_NOT_FOUND") {
    return {
      ok: false,
      code,
      message:
        "That code didn't match. Codes stop working after 5 minutes. In BrowserHarness, press Pair again and type the new code."
    };
  }
  if (code === "BRIDGE_NOT_RUNNING") {
    return {
      ok: false,
      code,
      message: "The helper app stopped. Close this page and double-click the installer again."
    };
  }
  return { ok: false, code: code || "PAIRING_FAILED", message: result?.error?.message || result?.message || "Pairing didn't work. Please try again." };
}

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${PAGE_TITLE}</title>
<style>
  :root { --bg:#f5f6fa; --card:#fff; --text:#16181d; --muted:#5b616e; --line:#e3e5ec; --brand:#4f46e5; --ok:#1a7f4b; --okbg:#e8f6ee; --bad:#b3261e; --badbg:#fdecea; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111318; --card:#1a1d24; --text:#eceef3; --muted:#a3a9b6; --line:#2b2f38; --brand:#8b85ff; --ok:#4cc38a; --okbg:#15291f; --bad:#ff8a80; --badbg:#2d1715; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:17px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width:620px; margin:0 auto; padding:40px 18px 60px; }
  h1 { font-size:28px; line-height:1.25; margin:0 0 6px; }
  .intro { color:var(--muted); margin:0 0 26px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:20px 22px; margin-bottom:16px; }
  .row { display:flex; gap:14px; align-items:flex-start; }
  .dot { flex:none; width:30px; height:30px; border-radius:50%; display:grid; place-items:center; font-weight:700; background:var(--line); color:var(--muted); }
  .dot.ok { background:var(--ok); color:#fff; }
  .dot.wait { border:3px solid var(--line); border-top-color:var(--brand); background:transparent; animation:spin 1s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .dot.wait { animation:none; } }
  h2 { font-size:19px; margin:2px 0 4px; }
  p { margin:0 0 8px; }
  .muted { color:var(--muted); }
  ol { margin:6px 0 14px; padding-left:22px; }
  form { display:flex; gap:10px; flex-wrap:wrap; }
  input { font:inherit; font-size:26px; letter-spacing:8px; width:220px; padding:8px 14px; border:2px solid var(--line); border-radius:12px; background:var(--card); color:var(--text); }
  input:focus { outline:none; border-color:var(--brand); }
  button { font:inherit; font-weight:700; padding:10px 22px; border:0; border-radius:12px; background:var(--brand); color:#fff; cursor:pointer; }
  button:disabled { opacity:.6; cursor:default; }
  .msg { margin-top:12px; padding:12px 14px; border-radius:12px; }
  .msg.bad { background:var(--badbg); color:var(--bad); }
  .done { text-align:center; padding:30px 22px; background:var(--okbg); border-color:transparent; }
  .done .big { width:64px; height:64px; margin:0 auto 12px; border-radius:50%; background:var(--ok); color:#fff; display:grid; place-items:center; font-size:34px; }
  [hidden] { display:none !important; }
</style>
</head>
<body>
<main>
  <h1>${PAGE_TITLE}</h1>
  <p class="intro">Two steps. Keep the small installer window open until this page says Connected.</p>

  <section class="card" aria-live="polite">
    <div class="row">
      <div class="dot wait" id="installDot" aria-hidden="true"></div>
      <div>
        <h2 id="installTitle">Checking the helper app…</h2>
        <p class="muted" id="installText"></p>
      </div>
    </div>
  </section>

  <section class="card" id="pairCard">
    <div class="row">
      <div class="dot" id="pairDot" aria-hidden="true">2</div>
      <div style="flex:1">
        <h2>Connect it to Chrome</h2>
        <ol>
          <li>In Chrome, click the BrowserHarness icon to open it.</li>
          <li>Open <strong>Settings</strong>, then <strong>Helper app</strong>, and press <strong>Pair</strong>.</li>
          <li>Type the 6 numbers it shows here, then press <strong>Connect</strong>.</li>
        </ol>
        <form id="pairForm">
          <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="000000" aria-label="Pairing code">
          <button id="pairButton" type="submit">Connect</button>
        </form>
        <div class="msg bad" id="pairError" role="alert" hidden></div>
      </div>
    </div>
  </section>

  <section class="card done" id="done" hidden role="status">
    <div class="big" aria-hidden="true">✓</div>
    <h2>Connected</h2>
    <p>The helper app is running and paired with Chrome. It starts by itself when you turn on your computer.</p>
    <p class="muted">You can close this page and the installer window.</p>
  </section>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  let finished = false;
  async function refresh() {
    if (finished) return;
    try {
      const s = await (await fetch("status")).json();
      $("installDot").className = "dot " + (s.running ? "ok" : "wait");
      $("installDot").textContent = s.running ? "✓" : "";
      $("installTitle").textContent = s.running ? "The helper app is installed and running" : "Starting the helper app…";
      const agents = (s.agents || []).filter((a) => a.status === "connected").map((a) => a.name);
      $("installText").textContent = s.running
        ? (s.starts_at_login ? "It starts by itself when you turn on your computer." : "It runs while this computer is on.") +
          (agents.length ? " Also connected to: " + agents.join(", ") + "." : "")
        : "This takes a few seconds.";
      if (s.extension_connected) {
        finished = true;
        $("pairCard").hidden = true;
        $("done").hidden = false;
      }
    } catch {
      $("installDot").className = "dot";
      $("installDot").textContent = "!";
      $("installTitle").textContent = "The installer window was closed";
      $("installText").textContent = "Double-click the installer again to finish.";
    }
  }
  $("pairForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("pairError").hidden = true;
    $("pairButton").disabled = true;
    $("pairButton").textContent = "Connecting…";
    try {
      const result = await (await fetch("pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: $("code").value }) })).json();
      if (!result.ok) {
        $("pairError").textContent = result.message;
        $("pairError").hidden = false;
      }
      await refresh();
    } catch {
      $("pairError").textContent = "The installer window was closed. Double-click the installer again.";
      $("pairError").hidden = false;
    } finally {
      $("pairButton").disabled = false;
      $("pairButton").textContent = "Connect";
    }
  });
  refresh();
  setInterval(refresh, 2000);
  $("code").focus();
</script>
</body>
</html>`;
