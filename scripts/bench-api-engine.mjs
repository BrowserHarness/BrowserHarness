#!/usr/bin/env node
// Browser vs API benchmark on the local fixture shop, in real Chromium with
// the built extension and Bridge. It measures, per run, the wall time of one
// search answered by:
//   browser  open the results page in a background tab, read it until the
//            results show, close the tab (what driving the page costs)
//   tier 1   the learned operation as plain HTTP from the Bridge
//   tier 2   a signed-in learned read, sent from a page of the site
//   tier 3   a page-only learned read, answered by loading the site's page
// Each mode runs back to back and then spaced 1.1 s apart, because the engine
// paces calls to one site (1 s by default) and back-to-back runs include that
// wait. Every measurement is written raw; the summary is computed from them.
// Local fixture only: these numbers say nothing about any real website.
// Usage: node scripts/bench-api-engine.mjs [--runs 10] [--out file.json]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHarness } from "./lib/api-engine-harness.mjs";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const RUNS = Math.max(1, Number(arg("runs", 10)));
const OUT = arg("out", path.join(os.tmpdir(), `browserharness-api-bench-${Date.now()}.json`));
const TERMS = [
  ["monitors", "27 inch monitor"],
  ["tablets", "Slate tablet"],
  ["keyboards", "Clicky keyboard"],
  ["laptops", "Aero 14 laptop"]
];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const setup = [];
const harness = await startHarness({ check: (name, ok, detail) => setup.push({ name, ok, detail }), title: "API benchmark" });
const { command, shop } = harness;
const record = {
  kind: "browserharness-api-engine-benchmark",
  started_at: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    cpus: `${os.cpus().length} x ${os.cpus()[0]?.model || "?"}`,
    browser: "Chromium (playwright-core, --headless=new)",
    site: "local fixture shop on 127.0.0.1 (apps/bridge/test/fixtures/api-shop.mjs)"
  },
  runs_per_mode: RUNS,
  learning: [],
  measurements: [],
  notes: [
    "Local fixture only; no real website was measured.",
    "back_to_back runs include the engine's per-site pacing (1 s minimum between calls to one site); spaced runs wait 1.1 s first, outside the measured time.",
    "Each measurement is one Bridge /command round trip measured by this script, including the Bridge, the extension and the browser."
  ]
};

async function learn(name, pagePath) {
  const learned = await command("bench", "site_skill", {
    action: "learn_api",
    ...(record.skill_id ? { id: record.skill_id } : { skill_name: "Benchmark shop" }),
    name,
    page_url: `${shop.origin}${pagePath}?q={q}`,
    examples: [{ q: "laptops" }, { q: "keyboards" }],
    verify_args: { q: "monitors" }
  });
  if (!learned.ok) throw new Error(`learning ${name} failed: ${JSON.stringify(learned.error)}`);
  record.skill_id ??= learned.data.candidate_id;
  record.learning.push({ operation: name, ms: learned.elapsed_ms, verification: learned.data.verification.status, answered_by_tier: learned.data.answered_by_tier, min_tier: learned.data.operation.min_tier });
  return learned.data.recipe_id;
}

async function browserRun(term, expected) {
  const started = performance.now();
  // observe:false keeps the browser path minimal: no page summary after opening
  const opened = await command("bench-browser", "open_tab", { url: `${shop.origin}/search?q=${encodeURIComponent(term)}`, active: false, observe: false });
  const tabId = opened.data?.tab_id;
  let ok = false;
  for (let i = 0; i < 100 && !ok; i += 1) {
    const page = await command("bench-browser", "read_page", { tab_id: tabId });
    ok = JSON.stringify(page.data || "").includes(expected);
    if (!ok) await wait(50);
  }
  await command("bench-browser", "close_tab", { tab_id: tabId, observe: false });
  return { ok, ms: Math.round(performance.now() - started) };
}

async function apiRun(recipeId, term, expected) {
  const ran = await command("bench-api", "site_skill", { action: "run", id: record.skill_id, recipe_id: recipeId, parameters: { q: term } });
  const ok = Boolean(ran.ok && JSON.stringify(ran.data?.run?.output?.data || "").includes(expected));
  return { ok, ms: ran.elapsed_ms, tier: ran.data?.run?.output?.api?.tier, class: ran.data?.run?.output?.api?.class || ran.error?.code };
}

try {
  if (setup.some((step) => !step.ok)) throw new Error(`setup failed: ${JSON.stringify(setup)}`);
  const recipes = {
    tier1: await learn("search", "/search"),
    tier2: await learn("orders", "/orders"),
    tier3: await learn("guarded", "/guarded")
  };
  const modes = [
    ["browser", (term, expected) => browserRun(term, expected)],
    ["tier1", (term, expected) => apiRun(recipes.tier1, term, expected)],
    ["tier2", (term, expected) => apiRun(recipes.tier2, term, expected)],
    ["tier3", (term, expected) => apiRun(recipes.tier3, term, expected)]
  ];
  // one unmeasured warm-up per mode (the first tier-2 run also finds and remembers its tier)
  for (const [, run] of modes) await run(...TERMS[0]);
  for (const pacing of ["back_to_back", "spaced"]) {
    for (const [mode, run] of modes) {
      for (let i = 0; i < RUNS; i += 1) {
        const [term, expected] = TERMS[i % TERMS.length];
        if (pacing === "spaced") await wait(1100);
        const result = await run(term, expected);
        record.measurements.push({ mode, pacing, run: i + 1, term, ...result });
        process.stdout.write(".");
      }
    }
  }
  process.stdout.write("\n");
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
} finally {
  await harness.close();
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1) + 0.5))];
record.summary = [];
for (const pacing of ["back_to_back", "spaced"]) {
  for (const mode of ["browser", "tier1", "tier2", "tier3"]) {
    const rows = record.measurements.filter((item) => item.mode === mode && item.pacing === pacing);
    if (!rows.length) continue;
    const ms = rows.map((item) => item.ms).sort((a, b) => a - b);
    record.summary.push({
      mode,
      pacing,
      runs: rows.length,
      correct: rows.filter((item) => item.ok).length,
      min_ms: ms[0],
      median_ms: quantile(ms, 0.5),
      p90_ms: quantile(ms, 0.9),
      max_ms: ms.at(-1),
      ...(mode !== "browser" ? { tiers_used: [...new Set(rows.map((item) => item.tier))] } : {})
    });
  }
}
record.finished_at = new Date().toISOString();
fs.writeFileSync(OUT, JSON.stringify(record, null, 2) + "\n");
console.table(record.summary);
console.log(`learning: ${record.learning.map((item) => `${item.operation} ${item.ms} ms`).join(", ")}`);
console.log(`raw measurements: ${OUT}`);
if (record.error) {
  console.error(record.error);
  process.exit(1);
}
process.exit(record.summary.every((row) => row.correct === row.runs) ? 0 : 1);
