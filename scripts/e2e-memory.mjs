#!/usr/bin/env node
// Local real-Chromium test of deeper memory with a scripted mock model (no real LLM, no network):
// past conversations come back when a request refers to them (chat, browser and /recall), the
// model picks lasting facts out of a message, a changed fact replaces the old one (kept as history,
// shown only for questions about the past), decisions replace each other, standing
// instructions go with every request, and a shared Skill imports from a link without running.
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

const reply = (res, content) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) } }] }));
};

const prompts = [];
const server = http
  .createServer((req, res) => {
    if (req.url.startsWith("/v1/chat/completions")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw);
        const all = body.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
        prompts.push(all);
        const user = String(body.messages.at(-1).content?.[0]?.text ?? body.messages.at(-1).content ?? "");
        if (user.startsWith("EXTRACT_FACTS")) {
          // For a short stay the model wrongly reads a new home; BrowserHarness must not keep it.
          if (user.includes("Goa")) return reply(res, '["I live in Goa"]');
          return reply(res, user.includes("Infosys") ? '["I work at Infosys", "I have two kids", "My card is 4111111111111111"]' : "[]");
        }
        const goal = /USER GOAL:\n([\s\S]*?)\n\nCURRENT PAGE OBSERVATION:/.exec(user)?.[1];
        if (goal) {
          return reply(res, { kind: "final", message: all.includes("FROM OUR PAST CONVERSATIONS") && all.includes("Philips") ? "AGENT_RECALL_OK" : "AGENT_NO_RECALL" });
        }
        if (user.includes("FROM OUR PAST CONVERSATIONS")) {
          return reply(res, user.includes("Philips HD9306") ? "RECALL_OK You picked the Philips HD9306." : "RECALL_WRONG");
        }
        return reply(res, "CHAT_OK");
      });
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end("<html><head><title>Kettles</title></head><body><h1>Kettles</h1><a href='/k'>Philips</a></body></html>");
  })
  .listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const port = server.address().port;

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bh-memory-"));
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
  await side.setViewportSize({ width: 430, height: 1400 });
  await side.goto(`chrome-extension://${extId}/sidepanel.html`);
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
  const sixDaysAgo = new Date(Date.now() - 6 * 86_400_000).toISOString();
  await side.evaluate(
    ([connection, sixDaysAgo]) =>
      chrome.storage.local.set({
        "browserharness.providerConnections": [connection],
        "browserharness.runtimeRouting": { primaryConnectionId: connection.id },
        "browserharness.taskHistory": [
          {
            id: "h1",
            task: "compare electric kettles under 2000 on amazon",
            result: "The Philips HD9306 at ₹1,599 is the cheapest of the three.",
            timestamp: sixDaysAgo,
            url: "https://amazon.in/s?k=kettle"
          },
          { id: "h2", task: "write a poem about rain", result: "Rain on the roof", timestamp: sixDaysAgo }
        ]
      }),
    [connection, sixDaysAgo]
  );
  await side.reload();
  await side.waitForTimeout(800);

  const box = () => side.locator("textarea").first();
  const ask = async (text) => {
    await page.goto(`http://localhost:${port}/`);
    await page.bringToFront();
    await box().fill(text);
    await side.getByRole("button", { name: "Send" }).click();
  };
  const sideText = () => side.locator("body").innerText();
  // The menu button's tooltip can cover "New chat" while the pointer rests on it, so move away first.
  const startNewChat = async () => {
    await side.getByRole("button", { name: "Open the menu" }).click();
    await side.mouse.move(5, 600);
    await side.getByRole("tooltip").waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    await side.getByRole("button", { name: "New chat" }).first().click();
    await side.waitForTimeout(400);
  };
  const waitText = (text, timeout = 20000) =>
    side.waitForFunction((text) => document.body.innerText.includes(text), text, { timeout }).catch(() => {});
  // Facts about this Space and facts for every Space (name and city go to every Space).
  const facts = () =>
    side.evaluate(async () => {
      const stored = await chrome.storage.local.get(["browserharness.aboutMe", "browserharness.aboutMe.global"]);
      return [...(stored["browserharness.aboutMe"] || []), ...(stored["browserharness.aboutMe.global"] || [])]
        .filter((fact) => !fact.status || fact.status === "current")
        .map((fact) => fact.text);
    });

  const savedInstructions = () => side.evaluate(async () => (await chrome.storage.local.get("browserharness.instructions"))["browserharness.instructions"] || "");

  // 1. A question about earlier work is answered from past conversations.
  await ask("what did I find last week about kettles?");
  await waitText("RECALL_OK");
  check("a question about earlier work is answered from past conversations", (await sideText()).includes("RECALL_OK You picked the Philips HD9306."));
  check("it says it is remembering", (await sideText()).includes("Remembering 1 past conversation"));
  const recallPromptText = prompts.find((text) => text.includes("FROM OUR PAST CONVERSATIONS")) || "";
  check("only the matching conversation is shared with the model", recallPromptText.includes("kettles") && !recallPromptText.includes("poem about rain"));

  // 2. Unrelated requests carry no history.
  const beforePlain = prompts.length;
  await ask("tell me a fun fact about owls");
  await waitText("CHAT_OK");
  check("unrelated requests carry no history", !prompts.slice(beforePlain).some((text) => text.includes("FROM OUR PAST CONVERSATIONS")));

  // 3. /recall lists matches without a model.
  const beforeRecall = prompts.length;
  await ask("/recall kettles");
  await waitText("From your past conversations about “kettles”");
  check("/recall lists matching conversations without a model", (await sideText()).includes("The Philips HD9306 at ₹1,599") && prompts.length === beforeRecall);

  // 4. Browser tasks get past conversations as context, and memory stays clean.
  // (A new chat, so it can only come from past conversations, not this chat.)
  await startNewChat();
  await ask("open this page and check the kettle I picked last time");
  await waitText("AGENT_", 30000);
  check("browser tasks get the past conversation too", (await sideText()).includes("AGENT_RECALL_OK"));
  const episodes = await side.evaluate(async () => JSON.stringify((await chrome.storage.local.get("browserharness.taskEpisodes.v1"))["browserharness.taskEpisodes.v1"] || []));
  check("task memory stores the request, not the recalled context", episodes.includes("kettle I picked") && !episodes.includes("FROM OUR PAST CONVERSATIONS"));

  // 5. The model picks lasting facts out of a message; secrets never stick.
  await ask("I work at Infosys and I have two kids, suggest a weekend plan");
  await waitText("Remembered about you", 20000);
  let known = await facts();
  check("the model's lasting facts are remembered", known.includes("I work at Infosys") && known.includes("I have two kids"), known.join("; "));
  check("a card number from the model is never stored", !known.some((fact) => /4111/.test(fact)));

  // 6. A changed fact replaces the old one.
  await ask("My name is Priya and I live in Pune");
  await waitText("CHAT_OK");
  await side.waitForTimeout(500);
  await ask("Actually I live in Mumbai now");
  await side.waitForTimeout(1500);
  known = await facts();
  check("a changed fact replaces the old one", known.includes("I live in Mumbai") && !known.includes("I live in Pune") && known.includes("My name is Priya"), known.join("; "));

  // 6b. A short stay or a maybe never replaces where you live, even if the AI reads it that way.
  await ask("I'm in Goa for two days, find a beach cafe");
  await waitText("CHAT_OK");
  await ask("I might move to Bengaluru next year");
  await side.waitForTimeout(2000);
  known = await facts();
  check("a short stay or a maybe doesn't replace your home", known.includes("I live in Mumbai") && !known.some((fact) => /Goa|Bengaluru/.test(fact)), known.join("; "));

  // 6c. A standing wish said in chat is offered, and one tap keeps it.
  await ask("Always prefer Indian sites from now on.");
  await waitText("Keep this as a standing wish?", 10000);
  check("a standing wish in chat is offered, not saved on its own", (await sideText()).includes("Keep this as a standing wish? “Always prefer Indian sites”") && !(await savedInstructions()));
  await side.getByTestId("memory-offer").getByRole("button", { name: "Keep it" }).last().click();
  await waitText("Kept as a standing wish.", 5000);
  check("one tap keeps it", (await savedInstructions()) === "Always prefer Indian sites");
  await side.evaluate(() => chrome.storage.local.remove("browserharness.instructions"));

  // 6d. A loose decision is offered; a settled one is kept with an undo.
  await ask("We'll deploy this on Cloudflare.");
  await waitText("Save as a decision? Deployment platform: Cloudflare", 10000);
  check("a loose decision is offered", (await sideText()).includes("Save as a decision? Deployment platform: Cloudflare"));
  await ask("Let's use Stripe for this project from now on.");
  await waitText("Remembered decision: Payments → Stripe", 10000);
  const decided = await side.evaluate(async () => ((await chrome.storage.local.get("browserharness.decisions.v1"))["browserharness.decisions.v1"] || []).map((item) => `${item.subject}: ${item.value}`));
  check("a settled decision is kept, and only that one", decided.join("; ") === "Payments: Stripe", decided.join("; "));
  await side.getByTestId("memory-offer").getByRole("button", { name: "Undo" }).last().click();
  await waitText("Taken back.", 5000);
  const undone = await side.evaluate(async () => ((await chrome.storage.local.get("browserharness.decisions.v1"))["browserharness.decisions.v1"] || []).length);
  check("undo takes it back", undone === 0);
  await side.getByRole("button", { name: "Open the menu" }).click();
  await side.getByRole("button", { name: "About me" }).click();
  await side.getByTestId("about-me-fact").first().waitFor({ timeout: 5000 });
  check("the About me screen explains past conversations and /recall", (await sideText()).includes("remembers your past tasks") && (await sideText()).includes("/recall"));

  // 7. Standing instructions go with every request; a password in them is refused.
  const instructions = side.getByLabel("Your instructions");
  await instructions.fill("My bank password is hunter22");
  await side.getByRole("button", { name: "Save instructions" }).click();
  await waitText("looks like a password", 5000);
  check("instructions with a password in them are not saved", (await savedInstructions()) === "");
  await instructions.fill("Always show prices in rupees.");
  await side.getByRole("button", { name: "Save instructions" }).click();
  await waitText("follows these from your next request", 5000);
  check("instructions are saved", (await savedInstructions()) === "Always show prices in rupees.");
  await side.getByLabel("Wishes for every Space", { exact: true }).fill("Prefer Indian sites.");
  await side.getByRole("button", { name: "Save for every Space" }).click();
  await side.waitForTimeout(600);
  check(
    "wishes for every Space are saved apart",
    (await side.evaluate(async () => (await chrome.storage.local.get("browserharness.instructions.global"))["browserharness.instructions.global"])) === "Prefer Indian sites."
  );
  await side.reload();
  await side.waitForTimeout(800);
  const beforeRules = prompts.length;
  await ask("which kettle shop near me is best?");
  for (let i = 0; i < 100 && prompts.length === beforeRules; i++) await side.waitForTimeout(100);
  check(
    "standing instructions go with the next request",
    prompts.slice(beforeRules).some(
      (text) => text.includes("HOW I WANT YOU TO WORK") && text.includes("Always show prices in rupees.") && text.includes("In every Space:\nPrefer Indian sites.")
    )
  );

  check(
    "only today's home goes with an ordinary request",
    prompts.slice(beforeRules).some((text) => text.includes("I live in Mumbai")) && !prompts.slice(beforeRules).some((text) => text.includes("Pune"))
  );

  // 7b. The old home is kept, and only comes back for a question about the past.
  const beforePast = prompts.length;
  await ask("Where did I live before Mumbai?");
  for (let i = 0; i < 100 && prompts.length === beforePast; i++) await side.waitForTimeout(100);
  check(
    "a question about the past gets the old home, marked as no longer true",
    prompts.slice(beforePast).some((text) => /NO LONGER TRUE[^\n]*\n- I live in Pune/.test(text))
  );

  // 7c. Decisions: a new one replaces the old, which is kept as history.
  await ask("/decide code home: Forgejo");
  await waitText("Noted: Code home is Forgejo", 5000);
  await ask("/decide code home: GitHub because the team works there");
  await waitText("I'll keep “Forgejo” as what you used before", 5000);
  // A new chat, so the decision comes from memory rather than from this chat.
  await startNewChat();
  const beforeDecision = prompts.length;
  await ask("draft the release notes");
  for (let i = 0; i < 100 && prompts.length === beforeDecision; i++) await side.waitForTimeout(100);
  const decisionPrompts = prompts.slice(beforeDecision);
  check(
    "the decision in force goes with requests, the old one does not",
    decisionPrompts.some((text) => text.includes("Code home: GitHub (because the team works there)")) &&
      // (The chat's own earlier turns still mention it; the memory blocks must not.)
      !decisionPrompts.some((text) => /(DECISIONS|ABOUT ME)[^]*?\n\n/.exec(text)?.[0].includes("Forgejo"))
  );
  const beforeRecipe = prompts.length;
  await ask("suggest a dinner recipe");
  for (let i = 0; i < 100 && prompts.length === beforeRecipe; i++) await side.waitForTimeout(100);
  check("an unrelated request carries no decisions", !prompts.slice(beforeRecipe).some((text) => text.includes("Code home")));
  await side.getByRole("button", { name: "Open the menu" }).click();
  await side.getByRole("button", { name: "About me" }).click();
  await side.getByTestId("decision").first().waitFor({ timeout: 5000 });
  check("About you lists the decision in force", (await side.getByTestId("decision").allInnerTexts()).join(" ").includes("GitHub"));
  await side.getByRole("button", { name: /Earlier decisions \(1\)/ }).click();
  check("…and the one it replaced", (await side.getByTestId("earlier-decision").allInnerTexts()).join(" ").includes("Forgejo"));
  await side.getByRole("button", { name: /What used to be true \(1\)/ }).click();
  check("About you shows what used to be true", (await side.getByTestId("earlier-fact").allInnerTexts()).join(" ").includes("I live in Pune"));
  await side.screenshot({ path: path.join(os.tmpdir(), "browserharness-memory-history.png"), fullPage: true });
  await side.reload();
  await side.waitForTimeout(800);

  // 8. A shared Skill can be imported from a link; it is saved, not run.
  await ctx.route("https://skills.example.test/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/markdown", body: "---\nname: Order masala tea\n---\n1. Open the shop\n2. Add masala tea to the cart" })
  );
  const beforeImport = prompts.length;
  await side.getByRole("button", { name: "Open the menu" }).click();
  await side.getByRole("button", { name: "Skills" }).click();
  await side.getByRole("button", { name: "From a link" }).click();
  await side.getByLabel("Link to a SKILL.md").fill("https://skills.example.test/tea/SKILL.md");
  await side.getByRole("button", { name: "Import", exact: true }).click();
  await waitText("Imported /", 10000);
  check("a Skill imports from a link", (await sideText()).includes("Order masala tea"));
  check("importing a Skill runs nothing", prompts.length === beforeImport);
  if (process.env.SHOT_DIR) await side.screenshot({ path: path.join(process.env.SHOT_DIR, "memory.png"), fullPage: true });
} catch (error) {
  check("memory e2e ran without crashing", false, error instanceof Error ? error.stack : String(error));
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} memory checks passed`);
process.exit(failed ? 1 : 0);
