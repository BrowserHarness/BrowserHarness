#!/usr/bin/env node
// Memory v2 Phase 8, in real Chromium with a scripted mock model (no real LLM, no network).
// A small Task DAG: a research worker reads a claim from one local page, a verifier checks it
// against a second local page and contradicts it. Then the saved task memory is inspected for
// the parent, both nodes, the edge, sessions, sources and verdict; a later task in the same
// Space recalls the claim only with its verdict; a task in another Space recalls nothing.
// Requires: npm run build, playwright-core. Never runs on GitHub Actions.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "apps/extension/dist");
if (!fs.existsSync(path.join(dist, "manifest.json"))) {
  console.error("Build first: npm run build");
  process.exit(2);
}

const prompts = [];
const reply = (res, content) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(content) } }] }));
};

const server = http
  .createServer((req, res) => {
    if (req.url.startsWith("/v1/chat/completions")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw);
        const user = String(body.messages.at(-1).content?.[0]?.text ?? body.messages.at(-1).content ?? "");
        if (user.includes("Ask up to 4 short questions")) return reply(res, { questions: [] });
        if (user.startsWith("WORKER SUBTASK:")) {
          const seen = user.split("OBSERVED TAB EVIDENCE:")[1]?.split("AVAILABLE EXTERNAL")[0] || "";
          if (user.includes("independent read-only VERIFIER")) {
            if (!seen.includes("/regulator")) return reply(res, { kind: "tool", tool: "open_tab", input: { url: `http://localhost:${port}/regulator?session_id=abcd1234efgh5678` }, note: "Opening the regulator page" });
            return reply(res, { kind: "final", message: "VERDICT: contradicted. The regulator page says Vendor A has no free plan." });
          }
          if (!seen.includes("/vendor")) return reply(res, { kind: "tool", tool: "open_tab", input: { url: `http://localhost:${port}/vendor` }, note: "Opening the vendor page" });
          return reply(res, { kind: "final", message: "Claim: Vendor A offers a free plan for everyone." });
        }
        prompts.push(user);
        if (user.includes("GOAL_VENDOR_DAG")) {
          if (!user.includes("agent:")) {
            return reply(res, {
              kind: "tool",
              tool: "agent",
              input: {
                dag: [
                  { id: "research-1", task: "Read the Vendor A pricing page and report its pricing claim", type: "research" },
                  { id: "verify-1", task: "Check the Vendor A pricing claim against the regulator page", type: "verify", dependencies: ["research-1"] }
                ]
              },
              note: "Research and verify"
            });
          }
          return reply(res, { kind: "final", message: "DAG finished: the free-plan claim did not hold up." });
        }
        if (user.includes("GOAL_VENDOR_RECALL")) return reply(res, { kind: "final", message: "RECALL finished." });
        return reply(res, { kind: "final", message: "Done." });
      });
      return;
    }
    res.setHeader("content-type", "text/html");
    if (req.url.startsWith("/vendor")) return res.end("<html><head><title>Vendor A pricing</title></head><body><h1>Vendor A</h1><p>Free plan for everyone!</p></body></html>");
    if (req.url.startsWith("/regulator")) return res.end("<html><head><title>Regulator register</title></head><body><h1>Vendor A</h1><p>Vendor A has no free plan.</p></body></html>");
    res.end("<html><head><title>Start</title></head><body><h1>Start page</h1></body></html>");
  })
  .listen(0);
const port = server.address().port;

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bh-provenance-"));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME || "/opt/pw-browsers/chromium",
  headless: false,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--headless=new", "--no-sandbox"]
});

try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const extId = sw.url().split("/")[2];
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${port}/`);
  const side = await ctx.newPage();
  await side.goto(`chrome-extension://${extId}/sidepanel.html`);
  const storage = (key) => side.evaluate((name) => chrome.storage.local.get(name).then((value) => value[name]), key);

  const healthy = { status: "healthy", latencyMs: 1, checkedAt: new Date().toISOString() };
  const connection = {
    provider: "openai-compatible",
    apiKey: "mock",
    model: "mock-agent",
    baseUrl: `http://localhost:${port}/v1`,
    id: `openai-compatible::http://localhost:${port}/v1::mock-agent`,
    label: "Mock",
    capabilities: { chat: true, agent: true, vision: false, embeddings: false, unknown: false },
    chatHealth: healthy,
    agentHealth: healthy,
    embeddingHealth: { status: "unknown" }
  };
  await side.evaluate(
    ([connection]) =>
      chrome.storage.local.set({
        "browserharness.providerConnections": [connection],
        "browserharness.runtimeRouting": { primaryConnectionId: connection.id },
        "browserharness.spaces": {
          spaces: [
            { id: "personal", name: "Personal", color: "#4F46E5", created_at: new Date(0).toISOString() },
            { id: "space-work", name: "Work", color: "#0EA5E9", created_at: new Date().toISOString() }
          ],
          active: "personal"
        }
      }),
    [connection]
  );
  await side.reload();
  await side.waitForTimeout(800);

  const ask = async (text, done) => {
    await page.bringToFront();
    await side.locator("textarea").first().fill(text);
    await side.getByRole("button", { name: "Send" }).click();
    await side.waitForFunction((needle) => document.body.innerText.includes(needle), done, { timeout: 45000 }).catch(() => {});
  };

  // 1. The DAG runs in Personal.
  await ask("GOAL_VENDOR_DAG open the start page and check whether Vendor A really has a free plan", "DAG finished");
  check("the DAG with a verifier finishes", (await side.locator("body").innerText()).includes("DAG finished"));

  let episode = null;
  for (let i = 0; i < 50 && !episode; i++) {
    episode = ((await storage("browserharness.taskEpisodes.v1")) || []).find((item) => item.dag_runs?.length);
    if (!episode) await side.waitForTimeout(100);
  }
  const run = episode?.dag_runs?.[0];
  const research = run?.nodes.find((node) => node.node_id === "research-1");
  const verify = run?.nodes.find((node) => node.node_id === "verify-1");
  check("the saved task keeps the DAG with its parent and action", Boolean(run) && run.parent_session_id === episode.session_id && /^action-\d+$/.test(run.action_id), JSON.stringify(run && { parent: run.parent_session_id, action: run.action_id }));
  check("the task and its DAG are in the Space it ran in", episode?.space_id === "personal");
  check(
    "the research node keeps its own session and the page it read",
    research?.status === "completed" && research.child_session_id?.startsWith(`${episode.session_id}:worker:`) && research.sources.some((source) => source.url.endsWith("/vendor")) && research.mode === "read",
    JSON.stringify(research)
  );
  check(
    "the verifier keeps its own session, the edge to what it checked and its page",
    verify?.status === "completed" && verify.child_session_id?.startsWith(`${episode.session_id}:worker:`) && verify.child_session_id !== research?.child_session_id && JSON.stringify(verify.depends_on) === '["research-1"]' && verify.sources.some((source) => source.url.includes("/regulator")),
    JSON.stringify(verify)
  );
  check("the verdict is saved exactly, on the verifier and on the claim it checked", verify?.verdict === "contradicted" && research?.checked_by?.[0]?.verdict === "contradicted");
  check(
    "sources are observed, the claim is derived, the verdict is a derived verification",
    research?.trust?.sources === "observed" && research?.trust?.finding === "derived" && verify?.trust?.verdict === "derived_verification" && /free plan/.test(research?.finding || "")
  );
  check("a session id in a source link is not kept", !JSON.stringify(episode || {}).includes("abcd1234efgh5678") && verify?.sources.some((source) => source.url.endsWith("/regulator")));
  const facts = (await storage("browserharness.aboutMe")) || [];
  const decisions = (await storage("browserharness.decisions.v1")) || [];
  check("nothing from the verifier became a fact or a decision", !JSON.stringify([facts, decisions]).includes("Vendor A"));

  // 2. A later task in the same Space recalls the claim only with its verdict.
  const before = prompts.length;
  await ask("GOAL_VENDOR_RECALL open the start page and check whether Vendor A has a free plan", "RECALL finished");
  const recall = prompts.slice(before).join("\n");
  check(
    "a later task in the same Space recalls the claim with its contradicted verdict",
    recall.includes("Vendor A offers a free plan for everyone") && recall.includes('"verdict":"contradicted"') && recall.includes("never repeat it as true"),
    recall.slice(0, 200).replace(/\n/g, " | ")
  );

  // 3. Another Space never sees it.
  await side.evaluate(() =>
    chrome.storage.local.get("browserharness.spaces").then((value) => chrome.storage.local.set({ "browserharness.spaces": { ...value["browserharness.spaces"], active: "space-work" } }))
  );
  await side.reload();
  await side.waitForTimeout(800);
  const beforeWork = prompts.length;
  await ask("GOAL_VENDOR_RECALL open the start page and check whether Vendor A has a free plan", "RECALL finished");
  for (let i = 0; i < 50 && prompts.length === beforeWork; i++) await side.waitForTimeout(100);
  const work = prompts.slice(beforeWork).join("\n");
  check("a task in another Space gets no verifier history", work.length > 0 && !work.includes("Vendor A offers") && !work.includes("contradicted\"") && work.includes("No relevant past task episodes were recalled"), work.slice(0, 200).replace(/\n/g, " | "));
  const saved = (await storage("browserharness.taskEpisodes.v1")) || [];
  check("the other Space's task was saved there without the DAG", saved.some((item) => item.space_id === "space-work") && !saved.some((item) => item.space_id === "space-work" && item.dag_runs));
} catch (error) {
  check("provenance e2e ran without crashing", false, error instanceof Error ? error.stack : String(error));
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} provenance checks passed`);
process.exit(failed ? 1 : 0);
