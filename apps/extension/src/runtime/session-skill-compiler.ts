import type {
  CandidateSkillEvaluation,
  CandidateSkillStatus
} from "./skill-compiler";
import type {
  BrowserSessionActionEvidence,
  BrowserSessionTargetEvidence,
  BrowserTaskSessionEvidence
} from "./session-evidence";
import type { ToolName } from "./protocol";

export type SessionSkillParameterType = "string" | "string[]";

export interface SessionSkillParameter {
  name: string;
  label: string;
  type: SessionSkillParameterType;
  required: true;
  source_action_id: string;
  input_key: "text" | "files";
  default_example?: string | string[];
  sensitive?: boolean;
}

export interface SessionSkillTarget {
  tag?: string;
  role?: string;
  accessible_name?: string;
  input_type?: string;
  recorded_element_ref?: string;
  recorded_semantic_ref?: string;
  resolution: "reobserve_semantic_evidence";
}

export interface SessionSkillTab {
  ref: string;
  source_tab_id: number;
}

export interface SessionSkillPlanEntry {
  kind: "operation";
  source_action_id: string;
  recorded_at: string;
  tab_ref: string;
  tool: ToolName;
  note: string;
  input: Record<string, unknown>;
  target?: SessionSkillTarget;
  parameter_bindings?: Array<{
    input_key: "text" | "files";
    parameter: string;
  }>;
  result_tab_ref?: string;
  after?: {
    tab_ref: string;
    url: string;
    title: string;
  };
  approval: {
    required: boolean;
    approved: boolean;
    description?: string;
  };
}

export interface SessionCandidateSkill {
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
  parameters: SessionSkillParameter[];
  plan: {
    entry: {
      url: string;
      tab_ref: string;
    };
    tabs: SessionSkillTab[];
    steps: SessionSkillPlanEntry[];
  };
  safety: {
    boundary_action_id: string;
    maximum_demonstrated_action_ordinal: number;
    maximum_demonstrated_plan_index: number;
    allow_undemonstrated_actions_after_boundary: false;
    approval_policy: "preserve_browserharness_approval_rules";
  };
  provenance: {
    source_kind: "browser_task_session_v1";
    source_session_id: string;
    source_session_version: 1;
    started_at: string;
    task: string;
    start_url: string;
    boundary_action_id: string;
    action_count: number;
    tab_count: number;
    final_tab_evidence: BrowserTaskSessionEvidence["tab_evidence"];
    input_examples: Array<{
      name: string;
      source_action_id: string;
      input_key: "text" | "files";
      value?: string | string[];
      sensitive: boolean;
    }>;
  };
  evaluations: CandidateSkillEvaluation[];
}

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || "session";
}

function skillId(sessionId: string): string {
  const token = sessionId
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `SK-SESSION-${token || "TASK"}`;
}

function assertCompilableSession(
  session: BrowserTaskSessionEvidence
): asserts session is BrowserTaskSessionEvidence & {
  status: "completed";
  boundary_action_id: string;
} {
  if (session.version !== 1) {
    throw new Error("SESSION_SKILL_COMPILE_REQUIRES_V1");
  }

  if (session.status !== "completed") {
    throw new Error("SESSION_SKILL_COMPILE_REQUIRES_COMPLETED_SESSION");
  }

  if (session.manual_handoffs?.length) {
    throw new Error(
      "SESSION_SKILL_COMPILE_REQUIRES_MANUAL_HANDOFF_PRECONDITION"
    );
  }

  if (session.actions.length === 0) {
    throw new Error("SESSION_SKILL_COMPILE_REQUIRES_ACTION_EVIDENCE");
  }

  const ids = session.actions.map((action) => action.id);
  if (ids.some((id) => !id)) {
    throw new Error("SESSION_SKILL_COMPILE_REQUIRES_ACTION_IDS");
  }

  if (new Set(ids).size !== ids.length) {
    throw new Error("SESSION_SKILL_COMPILE_REQUIRES_UNIQUE_ACTION_IDS");
  }

  if (!session.boundary_action_id) {
    throw new Error("SESSION_SKILL_COMPILE_REQUIRES_BOUNDARY");
  }

  const boundaryIndex = session.actions.findIndex(
    (action) => action.id === session.boundary_action_id
  );

  if (boundaryIndex === -1) {
    throw new Error("SESSION_SKILL_COMPILE_BOUNDARY_NOT_FOUND");
  }

  if (boundaryIndex !== session.actions.length - 1) {
    throw new Error("SESSION_SKILL_COMPILE_ACTIONS_AFTER_BOUNDARY");
  }

  if (
    session.actions.some(
      (action) =>
        action.approval.required && !action.approval.approved
    )
  ) {
    throw new Error(
      "SESSION_SKILL_COMPILE_CONTAINS_UNAPPROVED_ACTION"
    );
  }
}

function parameterBase(action: BrowserSessionActionEvidence): string {
  const target =
    action.target?.accessible_name ||
    action.target?.role ||
    action.tool;
  return slug(target).replace(/-/g, "_") || "input";
}

function uniqueParameterName(
  base: string,
  used: Map<string, number>
): string {
  const count = (used.get(base) || 0) + 1;
  used.set(base, count);
  return count === 1 ? base : `${base}_${count}`;
}

export function compileSessionInputs(
  session: BrowserTaskSessionEvidence
): SessionSkillParameter[] {
  assertCompilableSession(session);

  const used = new Map<string, number>();
  const parameters: SessionSkillParameter[] = [];

  for (const action of session.actions) {
    const text = action.input.text;
    if (
      (action.tool === "type" ||
        action.tool === "trusted_type") &&
      typeof text === "string"
    ) {
      const name = uniqueParameterName(parameterBase(action), used);
      const sensitive =
        action.target?.type?.toLowerCase() === "password";

      parameters.push({
        name,
        label:
          action.target?.accessible_name ||
          action.note ||
          "Text input",
        type: "string",
        required: true,
        source_action_id: action.id,
        input_key: "text",
        ...(sensitive
          ? { sensitive: true }
          : { default_example: text })
      });
    }

    const files = action.input.files;
    if (
      action.tool === "upload" &&
      Array.isArray(files) &&
      files.every((file) => typeof file === "string")
    ) {
      const name = uniqueParameterName("files", used);
      parameters.push({
        name,
        label:
          action.target?.accessible_name ||
          action.note ||
          "Files",
        type: "string[]",
        required: true,
        source_action_id: action.id,
        input_key: "files",
        sensitive: true
      });
    }
  }

  return parameters;
}

function toTarget(
  target: BrowserSessionTargetEvidence | undefined,
  recordedRef: unknown
): SessionSkillTarget | undefined {
  if (!target && typeof recordedRef !== "string") {
    return undefined;
  }

  return {
    ...(target?.tag ? { tag: target.tag } : {}),
    ...(target?.role ? { role: target.role } : {}),
    ...(target?.accessible_name
      ? { accessible_name: target.accessible_name }
      : {}),
    ...(target?.type ? { input_type: target.type } : {}),
    ...(target?.element_id
      ? { recorded_element_ref: target.element_id }
      : typeof recordedRef === "string"
        ? { recorded_element_ref: recordedRef }
        : {}),
    ...(target?.semantic_ref
      ? { recorded_semantic_ref: target.semantic_ref }
      : {}),
    resolution: "reobserve_semantic_evidence"
  };
}

function parseUrlExpectation(
  value: string
): Record<string, unknown> {
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

export function normalizeSessionPlan(
  session: BrowserTaskSessionEvidence
): SessionCandidateSkill["plan"] {
  assertCompilableSession(session);

  const tabs: SessionSkillTab[] = [];
  const tabRefs = new Map<number, string>();

  const registerTab = (tabId: number): string => {
    const current = tabRefs.get(tabId);
    if (current) return current;
    const ref = `tab_${tabs.length + 1}`;
    tabRefs.set(tabId, ref);
    tabs.push({ ref, source_tab_id: tabId });
    return ref;
  };

  const rootRef = registerTab(session.start.tab_id);
  const parameters = compileSessionInputs(session);
  const parametersByAction = new Map<
    string,
    SessionSkillParameter[]
  >();

  for (const parameter of parameters) {
    const current =
      parametersByAction.get(parameter.source_action_id) || [];
    current.push(parameter);
    parametersByAction.set(parameter.source_action_id, current);
  }

  const steps = session.actions.map((action) => {
    const actionParameters =
      parametersByAction.get(action.id) || [];
    const normalizedInput: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(action.input)) {
      if (key === "tab_id" && typeof value === "number") {
        normalizedInput.tab_ref = registerTab(value);
        continue;
      }

      if (key === "element_id") {
        continue;
      }

      const parameter = actionParameters.find(
        (candidate) => candidate.input_key === key
      );
      if (parameter) {
        normalizedInput[key] = {
          parameter: parameter.name
        };
        continue;
      }

      normalizedInput[key] = structuredClone(value);
    }

    const resultTabRef =
      typeof action.result_tab_id === "number"
        ? registerTab(action.result_tab_id)
        : undefined;
    const after = action.after
      ? {
          tab_ref: registerTab(action.after.tab_id),
          url: action.after.url,
          title: action.after.title
        }
      : undefined;
    const target = toTarget(
      action.target,
      action.input.element_id
    );

    const entry: SessionSkillPlanEntry = {
      kind: "operation",
      source_action_id: action.id,
      recorded_at: action.recorded_at,
      tab_ref: registerTab(action.before.tab_id),
      tool: action.tool,
      note: action.note,
      input: normalizedInput,
      ...(target ? { target } : {}),
      ...(actionParameters.length
        ? {
            parameter_bindings: actionParameters.map(
              (parameter) => ({
                input_key: parameter.input_key,
                parameter: parameter.name
              })
            )
          }
        : {}),
      ...(resultTabRef ? { result_tab_ref: resultTabRef } : {}),
      ...(after ? { after } : {}),
      approval: { ...action.approval }
    };

    return entry;
  });

  return {
    entry: {
      url: session.start.url,
      tab_ref: rootRef
    },
    tabs,
    steps
  };
}

export function compileSessionEvaluations(
  session: BrowserTaskSessionEvidence,
  plan: SessionCandidateSkill["plan"],
  parameters: SessionSkillParameter[]
): CandidateSkillEvaluation[] {
  assertCompilableSession(session);

  const evaluations: CandidateSkillEvaluation[] = [
    {
      id: "start-page-recognizable",
      kind: "start_page",
      description:
        "The Skill can recognize the browser task session start page.",
      expect: parseUrlExpectation(session.start.url)
    }
  ];

  for (const parameter of parameters) {
    const action = session.actions.find(
      (candidate) => candidate.id === parameter.source_action_id
    );
    evaluations.push({
      id: `input-${slug(parameter.name)}-available`,
      kind: "input_target",
      description:
        "The session-derived reusable input can be supplied at execution time.",
      expect: {
        parameter: parameter.name,
        type: parameter.type,
        source_action_id: parameter.source_action_id,
        input_key: parameter.input_key,
        sensitive: Boolean(parameter.sensitive),
        role: action?.target?.role || "",
        accessible_name:
          action?.target?.accessible_name || ""
      }
    });
  }

  const navigations = session.actions.filter(
    (action) =>
      (action.tool === "navigate" ||
        action.tool === "open_tab" ||
        action.tool === "find_tab") &&
      typeof action.input.url === "string"
  );

  for (const [index, action] of navigations.entries()) {
    evaluations.push({
      id: `navigation-${index + 1}-reachable`,
      kind: "navigation",
      description:
        "The session-derived Skill can reach a demonstrated URL target.",
      expect: {
        source_action_id: action.id,
        ...parseUrlExpectation(action.input.url as string)
      }
    });
  }

  if (plan.tabs.length > 1) {
    evaluations.push({
      id: "multi-tab-context-preserved",
      kind: "tab_context",
      description:
        "The Skill preserves the demonstrated task-session tab context.",
      expect: {
        minimum_tab_refs: plan.tabs.length,
        tab_refs: plan.tabs.map((tab) => tab.ref)
      }
    });
  }

  evaluations.push({
    id: "demonstrated-boundary-reachable",
    kind: "boundary",
    description:
      "Execution can reach the final successful session action without appending undemonstrated actions.",
    expect: {
      boundary_action_id: session.boundary_action_id,
      maximum_demonstrated_action_ordinal: session.actions.length,
      maximum_demonstrated_plan_index: plan.steps.length - 1,
      no_actions_after_boundary: true
    }
  });

  const approvalActionIds = session.actions
    .filter((action) => action.approval.required)
    .map((action) => action.id);

  if (approvalActionIds.length > 0) {
    evaluations.push({
      id: "approval-policy-preserved",
      kind: "approval",
      description:
        "Consequential session actions still obey BrowserHarness approval rules.",
      expect: {
        source_action_ids: approvalActionIds,
        policy: "preserve_browserharness_approval_rules"
      }
    });
  }

  if (
    session.actions.some(
      (action) =>
        Boolean(action.target) ||
        typeof action.input.element_id === "string"
    )
  ) {
    evaluations.push({
      id: "stale-locator-reobserve",
      kind: "stale_locator_recovery",
      description:
        "Recorded element refs are hints only; execution re-observes semantic evidence before targeting.",
      expect: {
        strategy: "reobserve_semantic_evidence"
      }
    });
  }

  return evaluations;
}

export function compileSessionToSkill(
  session: BrowserTaskSessionEvidence
): SessionCandidateSkill {
  assertCompilableSession(session);

  const parameters = compileSessionInputs(session);
  const plan = normalizeSessionPlan(session);

  return {
    schema_version: 1,
    id: skillId(session.session_id),
    slug: `session-${slug(session.title)}-${slug(
      session.session_id
    ).slice(0, 12)}`,
    name: session.title,
    version: "0.1.0",
    status: "candidate",
    lifecycle: {
      auto_promote: false,
      promotion_requires_evaluation: true
    },
    parameters,
    plan,
    safety: {
      boundary_action_id: session.boundary_action_id,
      maximum_demonstrated_action_ordinal:
        session.actions.length,
      maximum_demonstrated_plan_index: plan.steps.length - 1,
      allow_undemonstrated_actions_after_boundary: false,
      approval_policy: "preserve_browserharness_approval_rules"
    },
    provenance: {
      source_kind: "browser_task_session_v1",
      source_session_id: session.session_id,
      source_session_version: 1,
      started_at: session.started_at,
      task: session.task,
      start_url: session.start.url,
      boundary_action_id: session.boundary_action_id,
      action_count: session.actions.length,
      tab_count: plan.tabs.length,
      final_tab_evidence: session.tab_evidence.map(
        (evidence) => ({ ...evidence })
      ),
      input_examples: parameters.map((parameter) => ({
        name: parameter.name,
        source_action_id: parameter.source_action_id,
        input_key: parameter.input_key,
        ...(!parameter.sensitive &&
        parameter.default_example !== undefined
          ? { value: structuredClone(parameter.default_example) }
          : {}),
        sensitive: Boolean(parameter.sensitive)
      }))
    },
    evaluations: compileSessionEvaluations(
      session,
      plan,
      parameters
    )
  };
}
