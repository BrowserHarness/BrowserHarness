import {
  describeWorkflowStep,
  inferWorkflowInputs,
  type RecordedWorkflowStep,
  type SavedWorkflow,
  type WorkflowInput,
  type WorkflowLocator,
  type WorkflowRecordingEvent,
  type WorkflowRecordingSummary
} from "./workflows";

export type CandidateSkillStatus = "candidate";

export interface CandidateSkillParameter {
  name: string;
  label: string;
  type: "string";
  required: true;
  default_example: string;
  source_step_id: string;
}

export interface CandidateSkillTarget {
  tag: string;
  role: string;
  accessible_name: string;
  label?: string;
  element_text?: string;
  attributes?: Record<string, string>;
  input_type?: string;
  recorded_semantic_ref?: string;
}

export interface CandidateSkillTab {
  ref: string;
  source_tab_id?: number;
}

export type CandidateSkillPlanEntry =
  | {
      kind: "navigation";
      source_event_id: string;
      recorded_at: string;
      tab_ref: string;
      url: string;
      transition_type?: string;
      transition_qualifiers?: string[];
    }
  | {
      kind: "tab_opened";
      source_event_id: string;
      recorded_at: string;
      tab_ref: string;
      opener_tab_ref?: string;
      url?: string;
      title?: string;
    }
  | {
      kind: "tab_activated";
      source_event_id: string;
      recorded_at: string;
      tab_ref: string;
      window_id: number;
      url?: string;
      title?: string;
    }
  | {
      kind: "tab_closed";
      source_event_id: string;
      recorded_at: string;
      tab_ref: string;
    }
  | {
      kind: "action";
      source_step_id: string;
      recorded_at?: string;
      tab_ref: string;
      action: RecordedWorkflowStep["action"];
      description: string;
      target?: CandidateSkillTarget;
      pointer_example?: { x: number; y: number };
      parameter?: string;
      recorded_example?: string;
      key?: string;
      approval: {
        required: boolean;
        reason?: string;
      };
    };

export interface CandidateSkillPlan {
  entry: {
    url: string;
    tab_ref: string;
  };
  tabs: CandidateSkillTab[];
  steps: CandidateSkillPlanEntry[];
}

export type CandidateSkillEvaluationKind =
  | "start_page"
  | "input_target"
  | "navigation"
  | "tab_context"
  | "boundary"
  | "approval"
  | "stale_locator_recovery";

export interface CandidateSkillEvaluation {
  id: string;
  kind: CandidateSkillEvaluationKind;
  description: string;
  expect: Record<string, unknown>;
}

export interface CandidateSkillProvenance {
  source_kind: "watch_me_v3";
  source_workflow_id: string;
  source_workflow_version: 3;
  recorded_at: string;
  start_url: string;
  end_url?: string;
  boundary_step_id: string;
  action_count: number;
  context_event_count: number;
  recording?: WorkflowRecordingSummary;
  input_examples: Array<{
    name: string;
    value: string;
    source_step_id: string;
  }>;
}

export interface CandidateSkill {
  schema_version: 1;
  id: string;
  slug: string;
  name: string;
  version: "0.1.0";
  status: CandidateSkillStatus;
  lifecycle: {
    auto_promote: false;
    promotion_requires_evaluation: true;
  };
  parameters: CandidateSkillParameter[];
  plan: CandidateSkillPlan;
  safety: {
    boundary_step_id: string;
    maximum_demonstrated_action_ordinal: number;
    maximum_demonstrated_plan_index: number;
    allow_undemonstrated_actions_after_boundary: false;
    approval_policy: "preserve_browsercrew_approval_rules";
  };
  provenance: CandidateSkillProvenance;
  evaluations: CandidateSkillEvaluation[];
}

interface TimelineItem {
  recorded_at?: string;
  source_order: number;
  kind_order: number;
  step?: RecordedWorkflowStep;
  event?: WorkflowRecordingEvent;
}

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || "workflow";
}

function skillId(workflowId: string): string {
  const token = workflowId
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `SK-WATCH-${token || "WORKFLOW"}`;
}

function assertV3Workflow(
  workflow: SavedWorkflow
): asserts workflow is SavedWorkflow & {
  version: 3;
  boundary_step_id: string;
} {
  if (workflow.version !== 3) {
    throw new Error("SKILL_COMPILE_REQUIRES_WORKFLOW_V3");
  }

  if (workflow.steps.length === 0) {
    throw new Error("SKILL_COMPILE_REQUIRES_ACTIONABLE_EVIDENCE");
  }

  const stepIds = workflow.steps.map((step) => step.id);
  if (stepIds.some((id) => !id)) {
    throw new Error("SKILL_COMPILE_REQUIRES_STEP_IDS");
  }

  if (new Set(stepIds).size !== stepIds.length) {
    throw new Error("SKILL_COMPILE_REQUIRES_UNIQUE_STEP_IDS");
  }

  if (!workflow.boundary_step_id) {
    throw new Error("SKILL_COMPILE_REQUIRES_BOUNDARY_STEP_ID");
  }

  const boundaryIndex = workflow.steps.findIndex(
    (step) => step.id === workflow.boundary_step_id
  );

  if (boundaryIndex === -1) {
    throw new Error("SKILL_COMPILE_BOUNDARY_NOT_FOUND");
  }

  if (boundaryIndex !== workflow.steps.length - 1) {
    throw new Error("SKILL_COMPILE_ACTIONS_AFTER_BOUNDARY");
  }
}

function toTarget(locator?: WorkflowLocator): CandidateSkillTarget | undefined {
  if (!locator) return undefined;

  return {
    tag: locator.tag,
    role: locator.role,
    accessible_name: locator.accessible_name,
    ...(locator.label ? { label: locator.label } : {}),
    ...(locator.element_text ? { element_text: locator.element_text } : {}),
    ...(locator.attributes
      ? { attributes: { ...locator.attributes } }
      : {}),
    ...(locator.input_type ? { input_type: locator.input_type } : {}),
    ...(locator.semantic_ref
      ? { recorded_semantic_ref: locator.semantic_ref }
      : {})
  };
}

function approvalForStep(
  step: RecordedWorkflowStep
): { required: boolean; reason?: string } {
  const locator = step.locator;
  const enterRequiresApproval =
    step.action === "key" &&
    step.key === "Enter" &&
    Boolean(locator?.enter_requires_approval);

  const required =
    Boolean(locator?.requires_approval) || enterRequiresApproval;

  return {
    required,
    ...(required && locator?.approval_reason
      ? { reason: locator.approval_reason }
      : {})
  };
}

function parseUrlExpectation(value: string): Record<string, unknown> {
  try {
    const parsed = new URL(value);
    return {
      origin: parsed.origin,
      pathname: parsed.pathname
    };
  } catch {
    return { url: value };
  }
}

function sourceRootTabId(workflow: SavedWorkflow): number | undefined {
  const actionTab = workflow.steps.find(
    (step) => typeof step.tab_id === "number"
  )?.tab_id;
  if (typeof actionTab === "number") return actionTab;

  for (const event of workflow.events || []) {
    if (
      event.type === "tab_opened" &&
      typeof event.opener_tab_id === "number"
    ) {
      return event.opener_tab_id;
    }
    if (typeof event.tab_id === "number") return event.tab_id;
  }

  return undefined;
}

function buildTimeline(workflow: SavedWorkflow): TimelineItem[] {
  const timeline: TimelineItem[] = [];

  for (const [index, event] of (workflow.events || []).entries()) {
    timeline.push({
      recorded_at: event.recorded_at,
      source_order: index,
      kind_order: 0,
      event
    });
  }

  for (const [index, step] of workflow.steps.entries()) {
    timeline.push({
      recorded_at: step.recorded_at,
      source_order: index,
      kind_order: 1,
      step
    });
  }

  return timeline.sort((left, right) => {
    const leftTime = left.recorded_at
      ? Date.parse(left.recorded_at)
      : Number.NaN;
    const rightTime = right.recorded_at
      ? Date.parse(right.recorded_at)
      : Number.NaN;

    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
      if (leftTime !== rightTime) return leftTime - rightTime;
      if (left.kind_order !== right.kind_order) {
        return left.kind_order - right.kind_order;
      }
      return left.source_order - right.source_order;
    }

    if (Number.isFinite(leftTime)) return -1;
    if (Number.isFinite(rightTime)) return 1;
    if (left.kind_order !== right.kind_order) {
      return left.kind_order - right.kind_order;
    }
    return left.source_order - right.source_order;
  });
}

export function compileWorkflowInputs(
  workflow: SavedWorkflow
): CandidateSkillParameter[] {
  const sourceInputs: WorkflowInput[] =
    workflow.inputs && workflow.inputs.length > 0
      ? workflow.inputs
      : inferWorkflowInputs(workflow.steps);

  return sourceInputs.map((input) => {
    if (!input.step_id) {
      throw new Error("SKILL_COMPILE_INPUT_REQUIRES_SOURCE_STEP");
    }

    if (!workflow.steps.some((step) => step.id === input.step_id)) {
      throw new Error("SKILL_COMPILE_INPUT_SOURCE_STEP_NOT_FOUND");
    }

    return {
      name: input.name,
      label: input.label,
      type: "string",
      required: true,
      default_example: input.default,
      source_step_id: input.step_id
    };
  });
}

export function normalizeWorkflowPlan(
  workflow: SavedWorkflow
): CandidateSkillPlan {
  assertV3Workflow(workflow);

  const tabs: CandidateSkillTab[] = [];
  const tabRefs = new Map<number, string>();
  let syntheticRootRef: string | undefined;

  const registerTab = (sourceTabId?: number): string => {
    if (typeof sourceTabId !== "number") {
      if (!syntheticRootRef) {
        syntheticRootRef = `tab_${tabs.length + 1}`;
        tabs.push({ ref: syntheticRootRef });
      }
      return syntheticRootRef;
    }

    const existing = tabRefs.get(sourceTabId);
    if (existing) return existing;

    const ref = `tab_${tabs.length + 1}`;
    tabRefs.set(sourceTabId, ref);
    tabs.push({ ref, source_tab_id: sourceTabId });
    return ref;
  };

  const rootRef = registerTab(sourceRootTabId(workflow));
  const parameters = compileWorkflowInputs(workflow);
  const parameterByStep = new Map(
    parameters.map((parameter) => [parameter.source_step_id, parameter])
  );

  const steps: CandidateSkillPlanEntry[] = [];

  for (const item of buildTimeline(workflow)) {
    if (item.event) {
      const event = item.event;

      if (event.type === "navigation") {
        steps.push({
          kind: "navigation",
          source_event_id: event.id,
          recorded_at: event.recorded_at,
          tab_ref: registerTab(event.tab_id),
          url: event.url,
          ...(event.transition_type
            ? { transition_type: event.transition_type }
            : {}),
          ...(event.transition_qualifiers
            ? { transition_qualifiers: [...event.transition_qualifiers] }
            : {})
        });
        continue;
      }

      if (event.type === "tab_opened") {
        steps.push({
          kind: "tab_opened",
          source_event_id: event.id,
          recorded_at: event.recorded_at,
          tab_ref: registerTab(event.tab_id),
          ...(typeof event.opener_tab_id === "number"
            ? { opener_tab_ref: registerTab(event.opener_tab_id) }
            : {}),
          ...(event.url ? { url: event.url } : {}),
          ...(event.title ? { title: event.title } : {})
        });
        continue;
      }

      if (event.type === "tab_activated") {
        steps.push({
          kind: "tab_activated",
          source_event_id: event.id,
          recorded_at: event.recorded_at,
          tab_ref: registerTab(event.tab_id),
          window_id: event.window_id,
          ...(event.url ? { url: event.url } : {}),
          ...(event.title ? { title: event.title } : {})
        });
        continue;
      }

      steps.push({
        kind: "tab_closed",
        source_event_id: event.id,
        recorded_at: event.recorded_at,
        tab_ref: registerTab(event.tab_id)
      });
      continue;
    }

    const step = item.step;
    if (!step || !step.id) continue;

    const parameter = parameterByStep.get(step.id);
    const approval = approvalForStep(step);

    steps.push({
      kind: "action",
      source_step_id: step.id,
      ...(step.recorded_at ? { recorded_at: step.recorded_at } : {}),
      tab_ref: registerTab(step.tab_id),
      action: step.action,
      description: step.description || describeWorkflowStep(step),
      ...(step.locator ? { target: toTarget(step.locator) } : {}),
      ...(step.action === "click" && step.pointer
        ? { pointer_example: { ...step.pointer } }
        : {}),
      ...(step.action === "type" && parameter
        ? {
            parameter: parameter.name,
            recorded_example: parameter.default_example
          }
        : {}),
      ...(step.action === "key" ? { key: step.key } : {}),
      approval
    });
  }

  return {
    entry: {
      url: workflow.url,
      tab_ref: rootRef
    },
    tabs,
    steps
  };
}

export function buildSkillProvenance(
  workflow: SavedWorkflow,
  parameters: CandidateSkillParameter[]
): CandidateSkillProvenance {
  assertV3Workflow(workflow);

  return {
    source_kind: "watch_me_v3",
    source_workflow_id: workflow.id,
    source_workflow_version: 3,
    recorded_at: workflow.created_at,
    start_url: workflow.url,
    ...(workflow.end_url ? { end_url: workflow.end_url } : {}),
    boundary_step_id: workflow.boundary_step_id,
    action_count: workflow.steps.length,
    context_event_count: workflow.events?.length || 0,
    ...(workflow.recording ? { recording: { ...workflow.recording } } : {}),
    input_examples: parameters.map((parameter) => ({
      name: parameter.name,
      value: parameter.default_example,
      source_step_id: parameter.source_step_id
    }))
  };
}

export function compileWorkflowEvaluations(
  workflow: SavedWorkflow,
  plan: CandidateSkillPlan,
  parameters: CandidateSkillParameter[]
): CandidateSkillEvaluation[] {
  assertV3Workflow(workflow);

  const evaluations: CandidateSkillEvaluation[] = [
    {
      id: "start-page-recognizable",
      kind: "start_page",
      description: "The Skill can recognize the demonstrated start page.",
      expect: parseUrlExpectation(workflow.url)
    }
  ];

  for (const parameter of parameters) {
    const sourceStep = workflow.steps.find(
      (step) => step.id === parameter.source_step_id
    );

    evaluations.push({
      id: `input-${slug(parameter.name)}-locatable`,
      kind: "input_target",
      description: `The reusable input "${parameter.label}" can be located from recorded semantic evidence.`,
      expect: {
        parameter: parameter.name,
        source_step_id: parameter.source_step_id,
        role: sourceStep?.locator?.role || "",
        accessible_name: sourceStep?.locator?.accessible_name || "",
        label: sourceStep?.locator?.label || ""
      }
    });
  }

  for (const [index, event] of (workflow.events || [])
    .filter(
      (event): event is Extract<
        WorkflowRecordingEvent,
        { type: "navigation" }
      > => event.type === "navigation"
    )
    .entries()) {
    evaluations.push({
      id: `navigation-${index + 1}-reachable`,
      kind: "navigation",
      description: "The compiled plan can reach a demonstrated navigation target.",
      expect: {
        source_event_id: event.id,
        ...parseUrlExpectation(event.url)
      }
    });
  }

  if (plan.tabs.length > 1) {
    evaluations.push({
      id: "multi-tab-context-preserved",
      kind: "tab_context",
      description: "The Skill preserves the demonstrated multi-tab context.",
      expect: {
        minimum_tab_refs: plan.tabs.length,
        tab_refs: plan.tabs.map((tab) => tab.ref)
      }
    });
  }

  const boundaryPlanIndex = plan.steps.findIndex(
    (entry) =>
      entry.kind === "action" &&
      entry.source_step_id === workflow.boundary_step_id
  );
  const boundaryActionOrdinal =
    workflow.steps.findIndex(
      (step) => step.id === workflow.boundary_step_id
    ) + 1;

  evaluations.push({
    id: "demonstrated-boundary-reachable",
    kind: "boundary",
    description:
      "Execution can reach the final demonstrated action without adding actions beyond it.",
    expect: {
      boundary_step_id: workflow.boundary_step_id,
      maximum_demonstrated_action_ordinal: boundaryActionOrdinal,
      maximum_demonstrated_plan_index: boundaryPlanIndex,
      no_actions_after_boundary: true
    }
  });

  const approvalStepIds = workflow.steps
    .filter((step) => approvalForStep(step).required)
    .map((step) => step.id);

  if (approvalStepIds.length > 0) {
    evaluations.push({
      id: "approval-policy-preserved",
      kind: "approval",
      description:
        "Consequential recorded actions still obey BrowserHarness approval rules.",
      expect: {
        source_step_ids: approvalStepIds,
        policy: "preserve_browsercrew_approval_rules"
      }
    });
  }

  if (workflow.steps.some((step) => Boolean(step.locator))) {
    evaluations.push({
      id: "stale-locator-reobserve",
      kind: "stale_locator_recovery",
      description:
        "A stale recorded target is recovered by re-observing semantic evidence rather than inventing a selector.",
      expect: {
        strategy: "reobserve_semantic_evidence"
      }
    });
  }

  return evaluations;
}

export function compileWorkflowToSkill(
  workflow: SavedWorkflow
): CandidateSkill {
  assertV3Workflow(workflow);

  const parameters = compileWorkflowInputs(workflow);
  const plan = normalizeWorkflowPlan(workflow);
  const maximumDemonstratedPlanIndex = plan.steps.findIndex(
    (entry) =>
      entry.kind === "action" &&
      entry.source_step_id === workflow.boundary_step_id
  );

  if (maximumDemonstratedPlanIndex === -1) {
    throw new Error("SKILL_COMPILE_BOUNDARY_PLAN_ENTRY_NOT_FOUND");
  }

  const maximumDemonstratedActionOrdinal =
    workflow.steps.findIndex(
      (step) => step.id === workflow.boundary_step_id
    ) + 1;

  return {
    schema_version: 1,
    id: skillId(workflow.id),
    slug: `watch-${slug(workflow.name)}-${slug(workflow.id).slice(0, 12)}`,
    name: workflow.name,
    version: "0.1.0",
    status: "candidate",
    lifecycle: {
      auto_promote: false,
      promotion_requires_evaluation: true
    },
    parameters,
    plan,
    safety: {
      boundary_step_id: workflow.boundary_step_id,
      maximum_demonstrated_action_ordinal:
        maximumDemonstratedActionOrdinal,
      maximum_demonstrated_plan_index: maximumDemonstratedPlanIndex,
      allow_undemonstrated_actions_after_boundary: false,
      approval_policy: "preserve_browsercrew_approval_rules"
    },
    provenance: buildSkillProvenance(workflow, parameters),
    evaluations: compileWorkflowEvaluations(
      workflow,
      plan,
      parameters
    )
  };
}
