// The helper app's window: after a double-click install, and whenever the
// person opens "BrowserHarness Helper" from their apps, this page shows
// whether the helper runs, lets them start or stop it, pair Chrome without a
// terminal, and see whether their Claude or ChatGPT plan can be used. It runs
// only while the window is open, on 127.0.0.1, behind a random secret path,
// and talks to the helper app as a local program (with its token), so the
// helper app itself still refuses web pages.
import crypto from "node:crypto";
import http from "node:http";

const PAGE_TITLE = "BrowserHarness Helper";

/**
 * @param {{
 *   status: () => Promise<{ running: boolean, extension_connected?: boolean, starts_at_login?: boolean, agents?: { name: string, status: string }[], plans?: { id: string, name: string, found: boolean, signed_in?: boolean, how?: string }[], platform?: string }>,
 *   approve: (code: string) => Promise<{ ok: boolean, code?: string, message?: string }>,
 *   actions?: Record<string, (body: Record<string, unknown>) => Promise<{ ok: boolean, message?: string }>>,
 *   secret?: string
 * }} options
 */
export function createSetupServer({ status, approve, actions = {}, secret = crypto.randomBytes(24).toString("hex") }) {
  let port = 0;
  let lastSeen = Date.now();
  let seen = false;
  let byeAt = 0;
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
  const readJson = async (req, res) => {
    if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
      send(res, 415, "text/plain", "JSON only");
      return null;
    }
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1024) {
        send(res, 413, "text/plain", "Too big");
        return null;
      }
    }
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" ? value : {};
  };

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
      seen = true;

      // The window says goodbye as it closes; a reload asks again straight after.
      if (req.method === "POST" && route === "bye") {
        byeAt = lastSeen;
        return send(res, 204, "text/plain", "");
      }
      if (req.method === "GET" && route === "") return send(res, 200, "text/html; charset=utf-8", PAGE_HTML);
      if (req.method === "GET" && route === "status") {
        return json(res, 200, { ...(await status()), can_control: Object.keys(actions).length > 0 });
      }
      if (req.method === "POST" && route === "pair") {
        const body = await readJson(req, res);
        if (!body) return;
        const code = String(body.code || "").replace(/\D/g, "");
        if (code.length !== 6) {
          return json(res, 200, { ok: false, code: "BAD_CODE", message: "The code has 6 numbers. Check you typed all of them." });
        }
        return json(res, 200, await approve(code));
      }
      if (req.method === "POST" && route.startsWith("do/")) {
        const action = actions[route.slice(3)];
        if (!Object.hasOwn(actions, route.slice(3)) || typeof action !== "function") return send(res, 404, "text/plain", "Not found");
        const body = await readJson(req, res);
        if (!body) return;
        return json(res, 200, await action(body));
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
    /** Whether the page has been opened at all. */
    wasOpened: () => seen,
    /** The window was closed (not just reloaded). */
    closedByPerson: () => byeAt > 0 && lastSeen === byeAt && Date.now() - byeAt > 5000,
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
      message: "The helper app is stopped. Press Start above, then try the code again."
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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=Poppins:wght@600&display=swap">
<style>
  :root { --bg:#f5f6fa; --card:#fff; --text:#16181d; --muted:#5b616e; --line:#e3e5ec; --brand:#4f46e5; --brandtext:#fff; --ok:#1a7f4b; --okbg:#e8f6ee; --bad:#b3261e; --badbg:#fdecea; --warn:#8a5a00; --warnbg:#fff4dc; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111318; --card:#1a1d24; --text:#eceef3; --muted:#a3a9b6; --line:#2b2f38; --brand:#8b85ff; --brandtext:#111318; --ok:#4cc38a; --okbg:#15291f; --bad:#ff8a80; --badbg:#2d1715; --warn:#f2c46b; --warnbg:#2b2312; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.55 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width:620px; margin:0 auto; padding:28px 18px 40px; }
  header { display:flex; align-items:center; gap:14px; margin-bottom:22px; }
  header svg { flex:none; }
  h1, h2 { font-family:Poppins,Inter,system-ui,sans-serif; font-weight:600; }
  h1 { font-size:24px; line-height:1.2; margin:0; }
  .sub { color:var(--muted); margin:2px 0 0; font-size:15px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:18px 20px; margin-bottom:14px; }
  .row { display:flex; gap:14px; align-items:flex-start; }
  .grow { flex:1; min-width:0; }
  .dot { flex:none; width:30px; height:30px; border-radius:50%; display:grid; place-items:center; font-weight:700; background:var(--line); color:var(--muted); }
  .dot.ok { background:var(--ok); color:#fff; }
  .dot.off { background:var(--badbg); color:var(--bad); }
  .dot.wait { border:3px solid var(--line); border-top-color:var(--brand); background:transparent; animation:spin 1s linear infinite; }
  .dot.pop { animation:pop .45s ease-out; }
  @keyframes spin { to { transform:rotate(360deg); } }
  @keyframes pop { 0% { transform:scale(.4); } 70% { transform:scale(1.15); } 100% { transform:scale(1); } }
  @media (prefers-reduced-motion: reduce) { .dot.wait, .dot.pop { animation:none; } }
  h2 { font-size:18px; margin:2px 0 4px; }
  p { margin:0 0 8px; }
  .muted { color:var(--muted); }
  ol { margin:6px 0 14px; padding-left:22px; }
  form { display:flex; gap:10px; flex-wrap:wrap; }
  input[type=text] { font:inherit; font-size:24px; letter-spacing:8px; width:210px; padding:8px 14px; border:2px solid var(--line); border-radius:12px; background:var(--card); color:var(--text); }
  input[type=text]:focus { outline:none; border-color:var(--brand); }
  button { font:inherit; font-weight:600; padding:9px 20px; border:0; border-radius:12px; background:var(--brand); color:var(--brandtext); cursor:pointer; }
  button.quiet { background:transparent; color:var(--text); border:1.5px solid var(--line); }
  button:disabled { opacity:.6; cursor:default; }
  .buttons { display:flex; gap:10px; flex-wrap:wrap; margin-top:10px; }
  .msg { margin-top:12px; padding:12px 14px; border-radius:12px; }
  .msg.bad { background:var(--badbg); color:var(--bad); }
  .msg.ok { background:var(--okbg); color:var(--ok); }
  .switch { display:flex; align-items:center; justify-content:space-between; gap:16px; cursor:pointer; }
  .switch input { appearance:none; flex:none; width:48px; height:28px; border-radius:14px; background:var(--line); position:relative; cursor:pointer; transition:background .2s; margin:0; }
  .switch input::after { content:""; position:absolute; top:3px; left:3px; width:22px; height:22px; border-radius:50%; background:#fff; transition:left .2s; box-shadow:0 1px 3px rgba(0,0,0,.25); }
  .switch input:checked { background:var(--ok); }
  .switch input:checked::after { left:23px; }
  .switch input:focus-visible { outline:2px solid var(--brand); outline-offset:2px; }
  .plan { display:flex; gap:12px; align-items:flex-start; padding:10px 0; border-top:1px solid var(--line); }
  .plan:first-of-type { border-top:0; }
  .badge { flex:none; font-size:13px; font-weight:600; padding:3px 10px; border-radius:999px; background:var(--line); color:var(--muted); }
  .badge.ok { background:var(--okbg); color:var(--ok); }
  .badge.warn { background:var(--warnbg); color:var(--warn); }
  code { font-family:ui-monospace,Consolas,monospace; font-size:14px; background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:2px 6px; word-break:break-all; }
  footer { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; margin-top:6px; color:var(--muted); font-size:14px; }
  footer button { font-size:14px; padding:6px 14px; }
  [hidden] { display:none !important; }
</style>
</head>
<body>
<main>
  <header>
    <svg width="44" height="44" viewBox="0 0 128 128" aria-hidden="true"><rect width="128" height="128" rx="22" fill="#141922"/><rect x="22" y="22" width="84" height="84" fill="none" stroke="#f3f4f6" stroke-width="12"/><rect x="40" y="40" width="18" height="48" fill="#6ea8fe"/><rect x="70" y="40" width="18" height="48" fill="#a78bfa"/></svg>
    <div>
      <h1>${PAGE_TITLE}</h1>
      <p class="sub">Lets BrowserHarness in Chrome do more on this computer.</p>
    </div>
  </header>

  <section class="card" aria-live="polite">
    <div class="row">
      <div class="dot wait" id="runDot" aria-hidden="true"></div>
      <div class="grow">
        <h2 id="runTitle">Checking the helper app…</h2>
        <p class="muted" id="runText"></p>
        <div class="buttons" id="runButtons" hidden>
          <button id="startButton" type="button" hidden>Start</button>
          <button id="restartButton" class="quiet" type="button" hidden>Restart</button>
          <button id="stopButton" class="quiet" type="button" hidden>Stop</button>
        </div>
        <div class="msg" id="runMsg" role="status" hidden></div>
      </div>
    </div>
  </section>

  <section class="card" id="pairCard">
    <div class="row">
      <div class="dot" id="pairDot" aria-hidden="true">2</div>
      <div class="grow">
        <h2>Connect it to Chrome</h2>
        <ol>
          <li>In Chrome, click the BrowserHarness icon to open it.</li>
          <li>Open <strong>Settings</strong>, then <strong>Helper app</strong>, and press <strong>Pair</strong>.</li>
          <li>Type the 6 numbers it shows here, then press <strong>Connect</strong>.</li>
        </ol>
        <form id="pairForm">
          <input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="000000" aria-label="Pairing code">
          <button id="pairButton" type="submit">Connect</button>
        </form>
        <div class="msg bad" id="pairError" role="alert" hidden></div>
      </div>
    </div>
  </section>

  <section class="card" id="done" hidden role="status">
    <div class="row">
      <div class="dot ok pop" aria-hidden="true">✓</div>
      <div class="grow">
        <h2>Connected to Chrome</h2>
        <p class="muted">BrowserHarness in Chrome can use the helper app.</p>
      </div>
    </div>
  </section>

  <section class="card" id="loginCard" hidden>
    <label class="switch">
      <span>
        <strong>Start when I turn on my computer</strong><br>
        <span class="muted" id="loginText">Recommended, so it's always ready.</span>
      </span>
      <input type="checkbox" id="loginSwitch" role="switch" aria-label="Start when I turn on my computer">
    </label>
  </section>

  <section class="card" id="plansCard" hidden>
    <h2>Use your Claude or ChatGPT plan</h2>
    <p class="muted">BrowserHarness can use a plan you already pay for, through its official app on this computer.</p>
    <div id="plans"></div>
  </section>

  <section class="card" id="agentsCard" hidden>
    <h2>Coding tools</h2>
    <p class="muted" id="agentsText"></p>
  </section>

  <footer>
    <span id="foot">You can close this window. The helper keeps running.</span>
    <button class="quiet" id="logsButton" type="button" hidden>Show the helper's notes</button>
  </footer>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  let gone = false;
  let wasConnected = null;
  let busy = false;

  async function post(path, body) {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
    return response.json();
  }

  function show(id, on) { $(id).hidden = !on; }

  function note(id, text, kind) {
    $(id).textContent = text || "";
    $(id).className = "msg " + (kind || "ok");
    $(id).hidden = !text;
  }

  function renderPlans(plans) {
    const box = $("plans");
    box.textContent = "";
    for (const plan of plans) {
      const row = document.createElement("div");
      row.className = "plan";
      const text = document.createElement("div");
      text.className = "grow";
      const name = document.createElement("strong");
      name.textContent = plan.name;
      text.appendChild(name);
      const detail = document.createElement("div");
      detail.className = "muted";
      if (plan.found && plan.signed_in !== false) {
        detail.textContent = "Ready. In BrowserHarness, choose it in Settings, then Your AI.";
      } else if (plan.found) {
        detail.textContent = "Found, but not signed in yet. To sign in, type this in PowerShell or Terminal: ";
        const code = document.createElement("code");
        code.textContent = plan.sign_in || "";
        detail.appendChild(code);
      } else {
        detail.textContent = "Not on this computer. To add it, type this in PowerShell or Terminal, then restart the helper: ";
        const code = document.createElement("code");
        code.textContent = plan.how || "";
        detail.appendChild(code);
      }
      text.appendChild(detail);
      const badge = document.createElement("span");
      badge.className = "badge " + (plan.found && plan.signed_in !== false ? "ok" : plan.found ? "warn" : "");
      badge.textContent = plan.found && plan.signed_in !== false ? "Ready" : plan.found ? "Sign in" : "Not added";
      row.appendChild(text);
      row.appendChild(badge);
      box.appendChild(row);
    }
  }

  function closed() {
    gone = true;
    $("runDot").className = "dot";
    $("runDot").textContent = "!";
    $("runTitle").textContent = "This window has stopped";
    $("runText").textContent = "Open " + document.title + " again from your apps to see it here.";
    for (const id of ["runButtons", "pairCard", "loginCard", "plansCard", "agentsCard", "logsButton"]) show(id, false);
    $("foot").textContent = "";
  }

  async function refresh() {
    if (gone || busy) return;
    let s;
    try {
      s = await (await fetch("status")).json();
    } catch {
      return closed();
    }
    const control = Boolean(s.can_control);
    $("runDot").className = "dot " + (s.running ? "ok" : control ? "off" : "wait");
    $("runDot").textContent = s.running ? "✓" : control ? "–" : "";
    $("runTitle").textContent = s.running ? "Running" : control ? "Stopped" : "Starting the helper app…";
    $("runText").textContent = s.running
      ? (s.starts_at_login ? "It starts by itself when you turn on your computer." : "It runs until you stop it or turn off your computer.")
      : control ? "BrowserHarness can't use the helper app while it's stopped." : "This takes a few seconds.";
    show("runButtons", control);
    show("startButton", control && !s.running);
    show("restartButton", control && s.running);
    show("stopButton", control && s.running);

    const connected = Boolean(s.running && s.extension_connected);
    show("pairCard", !connected);
    show("done", connected);
    if (connected && wasConnected === false) $("done").querySelector(".dot").className = "dot ok pop";
    wasConnected = connected;
    $("pairDot").textContent = "2";

    show("loginCard", control);
    $("loginSwitch").checked = Boolean(s.starts_at_login);

    const plans = s.plans || [];
    show("plansCard", plans.length > 0);
    if (plans.length) renderPlans(plans);

    const agents = (s.agents || []).filter((a) => a.status === "connected").map((a) => a.name);
    show("agentsCard", agents.length > 0);
    $("agentsText").textContent = agents.length ? "These can use your Chrome through BrowserHarness: " + agents.join(", ") + "." : "";
    show("logsButton", control);
  }

  async function act(name, body, doneText, button) {
    busy = true;
    const buttons = document.querySelectorAll("button, #loginSwitch");
    buttons.forEach((b) => (b.disabled = true));
    const label = button ? button.textContent : "";
    if (button) button.textContent = { start: "Starting…", stop: "Stopping…", restart: "Restarting…" }[name] || label;
    try {
      const result = await post("do/" + name, body);
      note("runMsg", result.ok ? doneText : result.message || "That didn't work. Please try again.", result.ok ? "ok" : "bad");
      if (result.ok && doneText) setTimeout(() => note("runMsg", ""), 4000);
    } catch {
      closed();
    } finally {
      if (button) button.textContent = label;
      buttons.forEach((b) => (b.disabled = false));
      busy = false;
      refresh();
    }
  }

  $("startButton").addEventListener("click", (e) => act("start", {}, "Started.", e.currentTarget));
  $("stopButton").addEventListener("click", (e) => act("stop", {}, "Stopped. Press Start when you need it again.", e.currentTarget));
  $("restartButton").addEventListener("click", (e) => act("restart", {}, "Restarted.", e.currentTarget));
  $("logsButton").addEventListener("click", () => post("do/logs", {}).catch(() => {}));
  $("loginSwitch").addEventListener("change", (e) => {
    const on = e.currentTarget.checked;
    act("login", { on }, on ? "It will start by itself when you turn on your computer." : "It won't start by itself any more. Open it from your apps when you need it.");
  });

  $("pairForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("pairError").hidden = true;
    $("pairButton").disabled = true;
    $("pairButton").textContent = "Connecting…";
    try {
      const result = await post("pair", { code: $("code").value });
      if (!result.ok) {
        $("pairError").textContent = result.message;
        $("pairError").hidden = false;
      }
      await refresh();
    } catch {
      closed();
    } finally {
      $("pairButton").disabled = false;
      $("pairButton").textContent = "Connect";
    }
  });
  window.addEventListener("pagehide", () => navigator.sendBeacon("bye"));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  refresh();
  setInterval(refresh, 2000);
  $("code").focus();
</script>
</body>
</html>`;
