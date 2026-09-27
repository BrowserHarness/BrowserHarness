import type {
  CandidateSkill,
  CandidateSkillPlanEntry,
  CandidateSkillTarget
} from "./skill-compiler";
import type {
  InteractiveElement,
  PageObservation,
  ToolName,
  ToolResult
} from "./protocol";

interface AxElement {
  element_id: string;
  role: string;
  name: string;
  disabled?: boolean;
}

interface AxSnapshot {
  elements: AxElement[];
}

export interface AdaptiveReplayDependencies {
  tool<T = unknown>(
    tool: ToolName,
    input?: Record<string, unknown>
  ): Promise<ToolResult<T>>;
  requestApproval(description: string): Promise<boolean>;
  isCancelled(): boolean;
}

export interface AdaptiveReplayOptions {
  parameters?: Record<string, string>;
}

export interface AdaptiveReplayResult {
  status: "completed" | "stopped" | "approval-cancelled";
  completed_plan_entries: number;
  boundary_reached: boolean;
  tab_map: Record<string, number>;
}

interface ResolvedTarget {
  element_id: string;
  input_mode: "dom" | "trusted";
  requires_approval: boolean;
  approval_reason?: string;
}

function normalized(value?: string): string {
  return (value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function nameScore(expected: string | undefined, actual: string): number {
  const left = normalized(expected);
  const right = normalized(actual);
  if (!left) return 0;
  if (left === right) return 12;
  if (
    left.length >= 4 &&
    right.length >= 4 &&
    (left.includes(right) || right.includes(left))
  ) {
    return 4;
  }
  return 0;
}

function domScore(
  target: CandidateSkillTarget,
  element: InteractiveElement
): number {
  let score = 0;
  if (normalized(target.role) === normalized(element.role)) score += 6;
  if (normalized(target.tag) === normalized(element.tag)) score += 2;
  score += nameScore(target.accessible_name, element.accessible_name);
  if (
    target.input_type &&
    normalized(target.input_type) === normalized(element.type)
  ) {
    score += 2;
  }
  return score;
}

function axScore(
  target: CandidateSkillTarget,
  element: AxElement
): number {
  let score = 0;
  if (normalized(target.role) === normalized(element.role)) score += 6;
  score += nameScore(target.accessible_name, element.name);
  return score;
}

function pickUniqueBest<T>(
  ranked: Array<{ value: T; score: number }>,
  minimum: number
): T | null {
  const sorted = ranked
    .filter((item) => item.score >= minimum)
    .sort((left, right) => right.score - left.score);

  if (!sorted.length) return null;
  if (
    sorted.length > 1 &&
    sorted[0].score === sorted[1].score
  ) {
    return null;
  }
  return sorted[0].value;
}

export function matchAdaptiveDomTarget(
  target: CandidateSkillTarget,
  observation: PageObservation
): InteractiveElement | null {
  return pickUniqueBest(
    observation.elements
      .filter((element) => !element.disabled && element.visible)
      .map((element) => ({
        value: element,
        score: domScore(target, element)
      })),
    8
  );
}

export function matchAdaptiveAxTarget(
  target: CandidateSkillTarget,
  snapshot: AxSnapshot
): AxElement | null {
  return pickUniqueBest(
    snapshot.elements
      .filter((element) => !element.disabled)
      .map((element) => ({
        value: element,
        score: axScore(target, element)
      })),
    8
  );
}

function samePageIdentity(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return (
      a.origin === b.origin &&
      a.pathname === b.pathname &&
      a.search === b.search
    );
  } catch {
    return left === right;
  }
}

function dataTabId(result: ToolResult): number | undefined {
  if (!result.data || typeof result.data !== "object") {
    return undefined;
  }
  const tabId = (result.data as { tab_id?: unknown }).tab_id;
  return typeof tabId === "number" ? tabId : undefined;
}

async function requireTool<T>(
  dependencies: AdaptiveReplayDependencies,
  tool: ToolName,
  input: Record<string, unknown>
): Promise<ToolResult<T>> {
  const result = await dependencies.tool<T>(tool, input);
  if (!result.ok) {
    throw new Error(
      result.error?.message ||
        `Adaptive replay tool failed: ${tool}`
    );
  }
  return result;
}

async function observeTab(
  dependencies: AdaptiveReplayDependencies,
  tabId?: number
): Promise<PageObservation> {
  const result = await requireTool<PageObservation>(
    dependencies,
    "observe_page",
    typeof tabId === "number" ? { tab_id: tabId } : {}
  );
  if (!result.data) {
    throw new Error("Adaptive replay observation returned no page");
  }
  return result.data;
}

async function resolveTarget(
  dependencies: AdaptiveReplayDependencies,
  tabId: number,
  target: CandidateSkillTarget
): Promise<ResolvedTarget> {
  const observation = await observeTab(dependencies, tabId);
  const dom = matchAdaptiveDomTarget(target, observation);

  if (dom) {
    return {
      element_id: dom.element_id,
      input_mode: "dom",
      requires_approval: Boolean(dom.requires_approval),
      ...(dom.approval_reason
        ? { approval_reason: dom.approval_reason }
        : {})
    };
  }

  const axResult = await requireTool<AxSnapshot>(
    dependencies,
    "ax_snapshot",
    { tab_id: tabId, max_elements: 300 }
  );
  const ax = axResult.data
    ? matchAdaptiveAxTarget(target, axResult.data)
    : null;

  if (!ax) {
    throw new Error(
      `ADAPTIVE_REPLAY_TARGET_NOT_FOUND: ${target.accessible_name || target.role}`
    );
  }

  return {
    element_id: ax.element_id,
    input_mode: "trusted",
    requires_approval: false
  };
}

function parameterValue(
  skill: CandidateSkill,
  action: Extract<CandidateSkillPlanEntry, { kind: "action" }>,
  options: AdaptiveReplayOptions
): string {
  if (!action.parameter) {
    return action.recorded_example || "";
  }

  const supplied = options.parameters?.[action.parameter];
  if (typeof supplied === "string") return supplied;

  const parameter = skill.parameters.find(
    (candidate) => candidate.name === action.parameter
  );
  if (parameter) return parameter.default_example;

  if (typeof action.recorded_example === "string") {
    return action.recorded_example;
  }

  throw new Error(
    `ADAPTIVE_REPLAY_PARAMETER_REQUIRED: ${action.parameter}`
  );
}

function approvalDescription(
  action: Extract<CandidateSkillPlanEntry, { kind: "action" }>,
  target: ResolvedTarget | null
): string | null {
  if (target?.requires_approval) {
    return (
      target.approval_reason ||
      `Activate “${action.target?.accessible_name || "this control"}”`
    );
  }

  if (action.approval.required) {
    return (
      action.approval.reason ||
      `Replay “${action.target?.accessible_name || action.description}”`
    );
  }

  return null;
}

async function executeAction(
  skill: CandidateSkill,
  action: Extract<CandidateSkillPlanEntry, { kind: "action" }>,
  tabId: number,
  dependencies: AdaptiveReplayDependencies,
  options: AdaptiveReplayOptions
): Promise<"executed" | "approval-cancelled"> {
  const target = action.target
    ? await resolveTarget(
        dependencies,
        tabId,
        action.target
      )
    : null;
  const approval = approvalDescription(action, target);

  if (approval) {
    const approved = await dependencies.requestApproval(approval);
    if (!approved) return "approval-cancelled";
  }

  if (action.action === "click") {
    if (!target) {
      throw new Error("ADAPTIVE_REPLAY_CLICK_TARGET_REQUIRED");
    }
    await requireTool(
      dependencies,
      target.input_mode === "trusted"
        ? "trusted_click"
        : "click",
      {
        tab_id: tabId,
        element_id: target.element_id
      }
    );
  } else if (action.action === "type") {
    if (!target) {
      throw new Error("ADAPTIVE_REPLAY_TYPE_TARGET_REQUIRED");
    }
    const text = parameterValue(skill, action, options);
    await requireTool(
      dependencies,
      target.input_mode === "trusted"
        ? "trusted_type"
        : "type",
      {
        tab_id: tabId,
        element_id: target.element_id,
        text,
        replace: true
      }
    );
  } else {
    const input: Record<string, unknown> = {
      tab_id: tabId,
      key: action.key
    };
    if (target) input.element_id = target.element_id;
    await requireTool(
      dependencies,
      target?.input_mode === "trusted"
        ? "trusted_key"
        : "press_key",
      input
    );
  }

  await requireTool(dependencies, "wait", {
    milliseconds: 350
  });
  await observeTab(dependencies, tabId);
  return "executed";
}

async function ensureMappedTab(
  tabMap: Map<string, number>,
  ownedRefs: Set<string>,
  ref: string,
  url: string | undefined,
  dependencies: AdaptiveReplayDependencies
): Promise<number> {
  const existing = tabMap.get(ref);
  if (typeof existing === "number") return existing;

  if (url) {
    const found = await dependencies.tool("find_tab", { url });
    if (found.ok) {
      const tabId = dataTabId(found);
      if (typeof tabId === "number") {
        tabMap.set(ref, tabId);
        return tabId;
      }
    }
  }

  const opened = await requireTool(
    dependencies,
    "open_tab",
    {
      ...(url ? { url } : {}),
      active: false
    }
  );
  const tabId = dataTabId(opened);
  if (typeof tabId !== "number") {
    throw new Error("ADAPTIVE_REPLAY_NEW_TAB_ID_REQUIRED");
  }
  tabMap.set(ref, tabId);
  ownedRefs.add(ref);
  return tabId;
}

export async function replayCandidateSkill(
  skill: CandidateSkill,
  dependencies: AdaptiveReplayDependencies,
  options: AdaptiveReplayOptions = {}
): Promise<AdaptiveReplayResult> {
  if (skill.status !== "candidate") {
    throw new Error("ADAPTIVE_REPLAY_REQUIRES_CANDIDATE_SKILL");
  }
  if (skill.safety.allow_undemonstrated_actions_after_boundary) {
    throw new Error("ADAPTIVE_REPLAY_UNSAFE_BOUNDARY_POLICY");
  }

  const boundaryIndex =
    skill.safety.maximum_demonstrated_plan_index;
  if (
    boundaryIndex < 0 ||
    boundaryIndex >= skill.plan.steps.length
  ) {
    throw new Error("ADAPTIVE_REPLAY_BOUNDARY_OUT_OF_RANGE");
  }

  const boundaryEntry = skill.plan.steps[boundaryIndex];
  if (
    boundaryEntry.kind !== "action" ||
    boundaryEntry.source_step_id !==
      skill.safety.boundary_step_id
  ) {
    throw new Error("ADAPTIVE_REPLAY_BOUNDARY_MISMATCH");
  }

  const initial = await observeTab(dependencies);
  const tabMap = new Map<string, number>([
    [skill.plan.entry.tab_ref, initial.tab_id]
  ]);
  const ownedRefs = new Set<string>();

  if (
    skill.plan.entry.url &&
    !samePageIdentity(initial.url, skill.plan.entry.url)
  ) {
    await requireTool(dependencies, "navigate", {
      tab_id: initial.tab_id,
      url: skill.plan.entry.url
    });
    await observeTab(dependencies, initial.tab_id);
  }

  let completed = 0;

  for (let index = 0; index <= boundaryIndex; index += 1) {
    if (dependencies.isCancelled()) {
      return {
        status: "stopped",
        completed_plan_entries: completed,
        boundary_reached: false,
        tab_map: Object.fromEntries(tabMap)
      };
    }

    const entry = skill.plan.steps[index];

    if (entry.kind === "navigation") {
      const tabId = await ensureMappedTab(
        tabMap,
        ownedRefs,
        entry.tab_ref,
        entry.url,
        dependencies
      );
      await requireTool(dependencies, "navigate", {
        tab_id: tabId,
        url: entry.url
      });
      await observeTab(dependencies, tabId);
      completed += 1;
      continue;
    }

    if (entry.kind === "tab_opened") {
      if (!tabMap.has(entry.tab_ref)) {
        const opened = await requireTool(
          dependencies,
          "open_tab",
          {
            ...(entry.url ? { url: entry.url } : {}),
            active: false
          }
        );
        const tabId = dataTabId(opened);
        if (typeof tabId !== "number") {
          throw new Error("ADAPTIVE_REPLAY_NEW_TAB_ID_REQUIRED");
        }
        tabMap.set(entry.tab_ref, tabId);
        ownedRefs.add(entry.tab_ref);
      }
      completed += 1;
      continue;
    }

    if (entry.kind === "tab_activated") {
      await ensureMappedTab(
        tabMap,
        ownedRefs,
        entry.tab_ref,
        entry.url,
        dependencies
      );
      completed += 1;
      continue;
    }

    if (entry.kind === "tab_closed") {
      const tabId = tabMap.get(entry.tab_ref);
      if (
        typeof tabId === "number" &&
        ownedRefs.has(entry.tab_ref)
      ) {
        await requireTool(dependencies, "close_tab", {
          tab_id: tabId
        });
        tabMap.delete(entry.tab_ref);
        ownedRefs.delete(entry.tab_ref);
      }
      completed += 1;
      continue;
    }

    const tabId = tabMap.get(entry.tab_ref);
    if (typeof tabId !== "number") {
      throw new Error(
        `ADAPTIVE_REPLAY_TAB_NOT_MAPPED: ${entry.tab_ref}`
      );
    }

    const executed = await executeAction(
      skill,
      entry,
      tabId,
      dependencies,
      options
    );

    if (executed === "approval-cancelled") {
      return {
        status: "approval-cancelled",
        completed_plan_entries: completed,
        boundary_reached: false,
        tab_map: Object.fromEntries(tabMap)
      };
    }

    completed += 1;
  }

  return {
    status: "completed",
    completed_plan_entries: completed,
    boundary_reached: true,
    tab_map: Object.fromEntries(tabMap)
  };
}
