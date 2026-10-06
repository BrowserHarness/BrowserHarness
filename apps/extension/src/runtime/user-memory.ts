// What the person told BrowserHarness, for a request in one Space: the
// standing instructions, facts and decisions for every Space plus that
// Space's own. The Space's own win where the two disagree. Only what is true
// now is sent; things that were replaced are added only when the request
// asks about the past, and are labelled as no longer true.
import {
  aboutMeFor,
  aboutMePrompt,
  earlierFactsFor,
  earlierFactsPrompt,
  loadAboutMe,
  loadGlobalAboutMe,
  type AboutMeFact
} from "./about-me";
import { currentDecisions, decisionsPrompt, earlierDecisionsFor, earlierDecisionsPrompt, type Decision } from "./decisions";
import { loadGlobalInstructions, loadInstructions, scopedInstructionsPrompt } from "./instructions";

/** What is true now in a Space: its own facts and decisions first, then those for every Space. */
export async function currentState(spaceId: string): Promise<{ facts: AboutMeFact[]; decisions: Decision[] }> {
  const [everySpaceFacts, spaceFacts, decisions] = await Promise.all([
    loadGlobalAboutMe().catch(() => []),
    loadAboutMe(spaceId).catch(() => []),
    currentDecisions(spaceId).catch(() => [])
  ]);
  return { facts: aboutMeFor(everySpaceFacts, spaceFacts), decisions };
}

/** What used to be true and matches a question about the past (empty for an ordinary request). */
export async function earlierState(question: string, spaceId: string): Promise<{ facts: AboutMeFact[]; decisions: Decision[] }> {
  const [facts, decisions] = await Promise.all([
    earlierFactsFor(question, spaceId).catch(() => []),
    earlierDecisionsFor(question, spaceId).catch(() => [])
  ]);
  return { facts, decisions };
}

export async function userMemoryPrompt(spaceId: string, request = ""): Promise<string> {
  const [everySpaceRules, spaceRules, now, before] = await Promise.all([
    loadGlobalInstructions().catch(() => ""),
    loadInstructions(spaceId).catch(() => ""),
    currentState(spaceId),
    request ? earlierState(request, spaceId) : Promise.resolve({ facts: [], decisions: [] })
  ]);
  return (
    scopedInstructionsPrompt(everySpaceRules, spaceRules) +
    aboutMePrompt(now.facts) +
    decisionsPrompt(now.decisions) +
    earlierFactsPrompt(before.facts) +
    earlierDecisionsPrompt(before.decisions)
  );
}
