import { describe, expect, it } from "vitest";
import { cantUseBrowser, diagnoseAi, diagnoseHelper, GUIDE_SLUGS, noModels, subscriptionAppMissing } from "./problems";
import { GUIDES, findGuide, parseGuide } from "./guides";

describe("diagnoseAi", () => {
  const cases: [string, Parameters<typeof diagnoseAi>[1], string][] = [
    ["Model request failed (401): invalid api key", { service: "OpenAI" }, "ai-key-rejected"],
    ["Model request failed (402): Insufficient credits", { service: "OpenRouter" }, "ai-key-rejected"],
    ["Model request failed (429): rate limit", {}, "ai-busy-or-limit"],
    ["Request timed out after 120000 ms", { local: true, app: "LM Studio" }, "ai-too-slow"],
    ["Failed to fetch", { local: true, app: "LM Studio" }, "local-ai-not-running"],
    ["Failed to fetch", { service: "Groq" }, "ai-cant-reach"],
    ["Could not load models (403)", { local: true, app: "Ollama" }, "ollama-blocked"],
    ["Model request failed (404): model not found", { model: "gpt-9" }, "ai-model-not-found"],
    ["The page is too big for x's context window (400)", { local: true }, "ai-page-too-big"],
    ["Chrome did not allow BrowserHarness to reach this AI", {}, "allow-address"],
    ["Sign-in was cancelled.", {}, "openrouter-sign-in"],
    ["Model qwen returned an empty response. Pick another model.", {}, "ai-cant-use-browser"],
    ["Something odd", {}, "something-went-wrong"]
  ];
  for (const [message, context, guide] of cases) {
    it(`${message} → ${guide}`, () => {
      const problem = diagnoseAi(new Error(message), context);
      expect(problem.guide).toBe(guide);
      expect(problem.fixes.length).toBeGreaterThan(0);
      expect(problem.detail).toBe(message);
    });
  }

  it("names the service and the local app", () => {
    expect(diagnoseAi("Model request failed (401)", { service: "Anthropic" }).title).toContain("Anthropic");
    expect(diagnoseAi("Failed to fetch", { local: true, app: "Ollama" }).title).toContain("Ollama");
  });
});

describe("other problems", () => {
  it("helper issues", () => {
    expect(diagnoseHelper("not-running").guide).toBe("helper-not-running");
    expect(diagnoseHelper("not-connected").guide).toBe("helper-not-connected");
    expect(diagnoseHelper("pairing-failed", new Error("The code expired. Press Pair again.")).reason).toMatch(/5 minutes/);
  });
  it("chat-only, no models, missing app", () => {
    expect(cantUseBrowser("tiny").guide).toBe("ai-cant-use-browser");
    expect(noModels({ local: true, app: "LM Studio" }).title).toContain("LM Studio");
    expect(subscriptionAppMissing("Codex").guide).toBe("subscription-app-missing");
  });
});

describe("guides", () => {
  it("every problem has a guide, and every guide is a known slug", () => {
    for (const slug of GUIDE_SLUGS) expect(findGuide(slug), slug).toBeTruthy();
    for (const guide of GUIDES) expect(GUIDE_SLUGS as readonly string[]).toContain(guide.slug);
  });
  it("shows only the reader's part of a knowledge base page", () => {
    const guide = parseGuide('---\ntype: guide\nslug: x\ntitle: "X title"\nsummary: "Short"\n---\n\n# X title\n\nBody text.\n\n## How to fix it\n1. Do it.\n\n## Related\n- [[knowledge/help/y]]\n\n## Sources\n- s\n');
    expect(guide).toEqual({ slug: "x", title: "X title", summary: "Short", body: "Body text.\n\n## How to fix it\n1. Do it.", related: ["y"] });
  });
  it("related guides all exist", () => {
    for (const guide of GUIDES) for (const slug of guide.related) expect(findGuide(slug), `${guide.slug} → ${slug}`).toBeDefined();
  });
  it("no guide uses words from the forbidden list", () => {
    for (const guide of GUIDES) expect(guide.body, guide.slug).not.toMatch(/configure|customi[sz]e|initiali[sz]e|enable functionality|feature flag/i);
  });
});
