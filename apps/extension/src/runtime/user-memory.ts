// What the person told BrowserHarness, read through the Context Compiler.
// Tasks compile their own context (context/index.ts contextFor); these are
// for overviews and checks: what is true now in a Space, and what used to be.
import type { AboutMeFact } from "./about-me";
import { aboutMeFor } from "./about-me";
import { compileContext, localMemorySource, renderContext } from "./context";
import type { Decision } from "./decisions";

/** What is true now in a Space: its own facts and decisions first, then those for every Space. */
export async function currentState(spaceId: string): Promise<{ facts: AboutMeFact[]; decisions: Decision[] }> {
  const current = await localMemorySource.currentState(spaceId);
  return { facts: aboutMeFor(current.facts.global, current.facts.space), decisions: current.decisions };
}

/** What used to be true and matches a question about the past (empty for an ordinary request). */
export async function earlierState(question: string, spaceId: string): Promise<{ facts: AboutMeFact[]; decisions: Decision[] }> {
  const { facts, decisions } = await localMemorySource.earlierState(question, spaceId);
  return { facts, decisions };
}

/**
 * The memory part of the context for a request in a Space (instructions,
 * facts, decisions, and history only for questions about the past), compiled
 * like a task's. With no request, every current fact and decision: an overview.
 */
export async function userMemoryPrompt(spaceId: string, request = ""): Promise<string> {
  const compiled = await compileContext({
    request,
    spaceId,
    intent: "chat",
    only: ["instructions", "facts", "decisions", "earlier"],
    budgetTarget: 4000
  });
  return renderContext(compiled, ["instructions", "facts", "decisions", "earlier"]);
}
