import {
  replayCandidateSkill,
  type AdaptiveReplayDependencies,
  type AdaptiveReplayOptions,
  type AdaptiveReplayResult
} from "./adaptive-replay";
import { compileWorkflowToSkill } from "./skill-compiler";
import type { SavedWorkflow } from "./workflows";

export function supportsAdaptiveWorkflowReplay(
  workflow: SavedWorkflow
): boolean {
  return workflow.version === 3;
}

export async function replaySavedWorkflowAdaptive(
  workflow: SavedWorkflow,
  dependencies: AdaptiveReplayDependencies,
  options: AdaptiveReplayOptions = {}
): Promise<AdaptiveReplayResult> {
  if (!supportsAdaptiveWorkflowReplay(workflow)) {
    throw new Error("ADAPTIVE_REPLAY_REQUIRES_WORKFLOW_V3");
  }

  const skill = compileWorkflowToSkill(workflow);
  return replayCandidateSkill(skill, dependencies, options);
}
