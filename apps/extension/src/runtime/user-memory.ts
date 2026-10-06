// What the person told BrowserHarness, for a request in one Space: the
// standing instructions and facts for every Space plus that Space's own.
// The Space's own win where the two disagree.
import { aboutMeFor, aboutMePrompt, loadAboutMe, loadGlobalAboutMe } from "./about-me";
import { loadGlobalInstructions, loadInstructions, scopedInstructionsPrompt } from "./instructions";

export async function userMemoryPrompt(spaceId: string): Promise<string> {
  const [everySpaceRules, spaceRules, everySpaceFacts, spaceFacts] = await Promise.all([
    loadGlobalInstructions().catch(() => ""),
    loadInstructions(spaceId).catch(() => ""),
    loadGlobalAboutMe().catch(() => []),
    loadAboutMe(spaceId).catch(() => [])
  ]);
  return scopedInstructionsPrompt(everySpaceRules, spaceRules) + aboutMePrompt(aboutMeFor(everySpaceFacts, spaceFacts));
}
