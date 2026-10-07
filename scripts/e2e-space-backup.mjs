#!/usr/bin/env node
// Memory v2 Phase 9, in real Chromium with a scripted mock model (no real LLM, no network).
// A Work Space gets a fact, a wish, a decision with history, a private Skill, a saved chat, a
// paused-to-be schedule and a browser task whose verifier contradicts a claim. Its backup is saved
// from Settings → Spaces and brought back as "Work (2)". The copy must hold all of Work's own
// memory (and nothing set for every Space or from another Space), keep the verifier's verdict
// through /recall, own its Skill privately under a new id and /command, bring its schedule back
// paused, and change independently of the original.
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
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) } }] }));
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
            if (!seen.includes("/regulator")) return reply(res, { kind: "tool", tool: "open_tab", input: { url: `http://localhost:${port}/regulator` }, note: "Opening the regulator page" });
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
          return reply(res, { kind: "final", message: "DAG finished. Vendor A has a free plan for everyone." });
        }
        // Chat replies (and anything else) are short and plain.
        return reply(res, body.response_format ? { kind: "final", message: "Done." } : "Done.");
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bh-backup-"));
const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "bh-backup-dl-"));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME || "/opt/pw-browsers/chromium",
  headless: false,
  acceptDownloads: true,
  downloadsPath: downloads,
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
  const setStorage = (values) => side.evaluate((values) => chrome.storage.local.set(values), values);
  const useSpace = async (id) => {
    const spaces = await storage("browserharness.spaces");
    await setStorage({ "browserharness.spaces": { ...spaces, active: id } });
    await side.reload();
    await side.waitForTimeout(800);
  };

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
  const now = new Date().toISOString();
  const skill = (id, name, slug, extra) => ({
    id,
    name,
    slug,
    description: `${name} steps`,
    instructions: "1. Open the billing page\n2. Pay the newest invoice",
    source: "chat",
    created_at: now,
    updated_at: now,
    runs: 3,
    successes: 3,
    failures: 0,
    lessons: ["The pay button is at the bottom"],
    ...extra
  });
  await setStorage({
    "browserharness.providerConnections": [connection],
    "browserharness.runtimeRouting": { primaryConnectionId: connection.id },
    "browserharness.spaces": {
      spaces: [
        { id: "personal", name: "Personal", color: "#4f6bed", created_at: new Date(0).toISOString() },
        { id: "space-work", name: "Work", color: "#0891b2", created_at: now }
      ],
      active: "space-work"
    },
    // A wish for Work, a wish for every Space, a private Work Skill, a Skill for every Space and a Work schedule.
    "browserharness.instructions@space-work": "Prices in rupees",
    "browserharness.instructions.global": "Always answer in English",
    "browserharness.skills": [
      skill("skill-pay", "Pay invoice", "pay-invoice", { space_id: "space-work", visibility: "space", provenance: { origin: "saved", space_id: "space-work", at: now } }),
      skill("skill-all", "Check weather", "check-weather", { space_id: "space-work", visibility: "all" })
    ],
    "browserharness.schedules": [
      { id: "sched-work", task: "/pay-invoice for this month", schedule: { kind: "daily", time: "08:00", days: [1] }, enabled: true, created_at: now, space_id: "space-work" }
    ]
  });
  await side.reload();
  await side.waitForTimeout(800);

  const ask = async (text, done, timeout = 45000) => {
    await page.bringToFront();
    const before = (await side.locator("body").innerText()).length;
    await side.locator("textarea").first().fill(text);
    await side.getByRole("button", { name: "Send" }).click();
    await side.waitForFunction(([needle, before]) => document.body.innerText.length > before && document.body.innerText.includes(needle), [done, before], { timeout }).catch(() => {});
  };
  const after = async (marker) => (await side.locator("body").innerText()).split(marker).pop() || "";

  // 1. Work gets its own memory, and a task whose verifier contradicts a claim.
  await ask("/remember my laptop is a ThinkPad", "ThinkPad");
  await ask("/remember my laptop is a MacBook", "MacBook");
  await ask("/decide code home: Forgejo", "Forgejo");
  await ask("/decide code home: GitHub because the team works there", "GitHub");
  await ask("/decide everywhere browser: Chrome", "Chrome");
  await ask("GOAL_VENDOR_DAG open the start page and check whether Vendor A really has a free plan", "DAG finished");
  let episode = null;
  for (let i = 0; i < 50 && !episode; i++) {
    episode = ((await storage("browserharness.taskEpisodes.v1")) || []).find((item) => item.dag_runs?.length && item.space_id === "space-work");
    if (!episode) await side.waitForTimeout(100);
  }
  check("Work has its memory and a verified task", Boolean(episode) && ((await storage("browserharness.aboutMe@space-work")) || []).some((fact) => /MacBook/.test(fact.text)));

  // 2. Save Work's backup from Settings → Spaces.
  const settings = await ctx.newPage();
  await settings.goto(`chrome-extension://${extId}/settings.html#spaces`);
  await settings.getByTestId("space-row").first().waitFor({ timeout: 8000 });
  const pageText = await settings.locator("main").innerText();
  check(
    "the Spaces page says what each Space keeps and warns that a backup is private",
    pageText.includes("The backup file may contain private information from this Space. Keep it somewhere you trust.") && pageText.includes("the Skills made or learned there") && !/Shared by all Spaces:.*Skills/.test(pageText)
  );
  const workRow = settings.getByTestId("space-row").filter({ hasText: "Work" });
  const [download] = await Promise.all([settings.waitForEvent("download", { timeout: 10000 }), workRow.getByRole("button", { name: "Save a backup" }).click()]);
  const file = path.join(downloads, download.suggestedFilename());
  await download.saveAs(file);
  const text = fs.readFileSync(file, "utf8");
  const backup = JSON.parse(text);
  check(
    "the backup is version 2 with Work's own memory, Skill, task evidence and schedule",
    backup.version === 2 && backup.source_space.name === "Work" && backup.manifest.counts.skills === 1 && backup.manifest.counts.episodes >= 1 && backup.manifest.counts.dag_runs === 1 && backup.manifest.counts.schedules === 1 && backup.manifest.counts.earlier_decisions === 1 && backup.manifest.counts.earlier_facts === 1,
    JSON.stringify(backup.manifest.counts)
  );
  // (The saved chat may quote "/decide everywhere browser: Chrome": a chat is an archive of what was said.)
  check(
    "the backup holds nothing set for every Space",
    !text.includes("Always answer in English") && !text.includes("Check weather") && !JSON.stringify(backup.data.tagged.decisions).includes("Chrome") && backup.data.tagged.decisions.length === 2
  );

  // 3. Bring it back beside the original.
  await settings.getByTestId("restore-input").setInputFiles(file);
  await settings.waitForFunction(() => document.body.innerText.includes("Brought back as"), null, { timeout: 10000 }).catch(() => {});
  const note = await settings.getByTestId("restore-note").innerText().catch(() => "");
  check("the restore says what came back, with the schedule paused", note.includes("Brought back as “Work (2)”") && note.includes("1 Skill") && note.includes("1 scheduled task (paused") && note.includes("/pay-invoice-2"), note.replace(/\n/g, " | "));
  const spaces = (await storage("browserharness.spaces")).spaces;
  const copy = spaces.find((space) => space.name === "Work (2)");
  check("the copy is a new Space next to Work", Boolean(copy) && spaces.some((space) => space.id === "space-work") && copy.id !== "space-work");
  const id = copy?.id;

  const facts = (await storage(`browserharness.aboutMe@${id}`)) || [];
  const macbook = facts.find((fact) => /MacBook/.test(fact.text));
  const thinkpad = facts.find((fact) => /ThinkPad/.test(fact.text));
  check("facts come back with their history", Boolean(macbook) && macbook.status !== "superseded" && thinkpad?.status === "superseded" && thinkpad?.superseded_by === macbook?.id, JSON.stringify(facts.map((fact) => [fact.text, fact.status])));
  check("the wish comes back, the every-Space wish stays where it was", (await storage(`browserharness.instructions@${id}`)) === "Prices in rupees" && (await storage("browserharness.instructions.global")) === "Always answer in English");
  const allDecisions = (await storage("browserharness.decisions.v1")) || [];
  const copyDecisions = allDecisions.filter((item) => item.space_id === id);
  const github = copyDecisions.find((item) => item.value === "GitHub");
  const forgejo = copyDecisions.find((item) => item.value === "Forgejo");
  const originalGithub = allDecisions.find((item) => item.space_id === "space-work" && item.value === "GitHub");
  check(
    "decisions come back with new ids and their history linked",
    copyDecisions.length === 2 && github?.supersedes === forgejo?.id && forgejo?.superseded_by === github?.id && github?.id !== originalGithub?.id && allDecisions.filter((item) => item.visibility === "all").length === 1
  );
  const skills = (await storage("browserharness.skills")) || [];
  const copySkill = skills.find((item) => item.space_id === id);
  check(
    "the Skill is private to the copy, under a new id and a free /command",
    copySkill?.visibility === "space" && copySkill.id !== "skill-pay" && copySkill.slug === "pay-invoice-2" && copySkill.runs === 3 && skills.find((item) => item.id === "skill-pay")?.slug === "pay-invoice" && skills.length === 3
  );
  const schedules = (await storage("browserharness.schedules")) || [];
  const copySchedule = schedules.find((item) => item.space_id === id);
  check(
    "the schedule comes back paused, in the copy, running the copy's Skill; the original keeps running",
    copySchedule?.enabled === false && !copySchedule.next_run_at && copySchedule.id !== "sched-work" && copySchedule.task === "/pay-invoice-2 for this month" && schedules.find((item) => item.id === "sched-work")?.enabled === true
  );
  const copyEpisode = ((await storage("browserharness.taskEpisodes.v1")) || []).find((item) => item.space_id === id && item.dag_runs?.length);
  const verify = copyEpisode?.dag_runs?.[0].nodes.find((node) => node.node_id === "verify-1");
  check(
    "the task evidence comes back under a new session, verdict and edges unchanged",
    Boolean(copyEpisode) && copyEpisode.session_id !== episode?.session_id && verify?.verdict === "contradicted" && JSON.stringify(verify.depends_on) === '["research-1"]' && verify.child_session_id?.startsWith(`${copyEpisode.session_id}:worker:`)
  );
  const copyHistory = (await storage(`browserharness.taskHistory@${id}`)) || [];
  check("the saved answer links to the copy's own task", copyHistory.some((entry) => entry.session_id === copyEpisode?.session_id));
  check("no search index was copied", !(((await storage("browserharness.taskEpisodeVectors.v1")) || []).length));

  // 4. In the copy, /recall still says the claim was contradicted.
  await useSpace(id);
  await page.bringToFront();
  await side.locator("textarea").first().fill("/recall Vendor A free plan");
  await side.getByRole("button", { name: "Send" }).click();
  await side.waitForFunction(() => document.body.innerText.includes("From your past conversations"), null, { timeout: 15000 }).catch(() => {});
  const recalled = await after("/recall Vendor A free plan");
  check("/recall in the copy keeps the verifier's contradiction", recalled.includes("CONTRADICTED") && !recalled.includes("Vendor A has a free plan for everyone"), recalled.slice(0, 240).replace(/\n/g, " | "));

  // 5. Changing the copy leaves Work alone.
  await ask("/remember my laptop is a Dell", "Dell");
  await ask("/decide code home: GitLab", "GitLab");
  await setStorage({ "browserharness.skills": ((await storage("browserharness.skills")) || []).map((item) => (item.id === copySkill?.id ? { ...item, lessons: ["Changed in the copy"], runs: 9 } : item)) });
  const workFacts = (await storage("browserharness.aboutMe@space-work")) || [];
  const workCode = ((await storage("browserharness.decisions.v1")) || []).find((item) => item.space_id === "space-work" && item.status === "current" && item.subject === "Code home");
  const workSkill = ((await storage("browserharness.skills")) || []).find((item) => item.id === "skill-pay");
  check(
    "changing the copy's fact, decision and Skill leaves Work unchanged",
    workFacts.some((fact) => /MacBook/.test(fact.text) && fact.status !== "superseded") && !workFacts.some((fact) => /Dell/.test(fact.text)) && workCode?.value === "GitHub" && workSkill?.runs === 3 && workSkill?.lessons[0] === "The pay button is at the bottom"
  );

  // 6. Another Space sees none of it.
  await useSpace("personal");
  await page.bringToFront();
  await side.locator("textarea").first().fill("/recall Vendor A free plan");
  await side.getByRole("button", { name: "Send" }).click();
  await side.waitForTimeout(1500);
  const personal = await after("/recall Vendor A free plan");
  check("Personal recalls nothing from Work or its copy", !personal.includes("Vendor A has") && !personal.includes("CONTRADICTED"), personal.slice(0, 160).replace(/\n/g, " | "));
  check("Personal has none of their notes", !JSON.stringify((await storage("browserharness.aboutMe")) || []).includes("MacBook"));

  // 7. Deleting the copy removes only what it owned.
  await settings.reload();
  const copyRow = settings.getByTestId("space-row").filter({ hasText: "Work (2)" });
  await copyRow.getByRole("button", { name: "Delete" }).click();
  const confirmText = await settings.getByRole("dialog").innerText().catch(() => "");
  await settings.getByRole("button", { name: "Delete Space" }).click();
  await copyRow.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  check("the delete question names its Skill and scheduled task", confirmText.includes("1 Skill made in it") && confirmText.includes("1 scheduled task"), confirmText.replace(/\n/g, " | "));
  const left = {
    skills: ((await storage("browserharness.skills")) || []).map((item) => item.id).sort(),
    schedules: ((await storage("browserharness.schedules")) || []).map((item) => item.id),
    decisions: ((await storage("browserharness.decisions.v1")) || []).filter((item) => item.space_id === id).length,
    episodes: ((await storage("browserharness.taskEpisodes.v1")) || []).filter((item) => item.space_id === id).length
  };
  check(
    "deleting the copy removes its records and schedule, and nothing of Work",
    JSON.stringify(left.skills) === JSON.stringify(["skill-all", "skill-pay"]) && JSON.stringify(left.schedules) === '["sched-work"]' && left.decisions === 0 && left.episodes === 0,
    JSON.stringify(left)
  );
} catch (error) {
  check("space backup e2e ran without crashing", false, error instanceof Error ? error.stack : String(error));
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(downloads, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} space backup checks passed`);
process.exit(failed ? 1 : 0);
