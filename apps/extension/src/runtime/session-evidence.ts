import type {
  InteractiveElement,
  PageObservation,
  ToolName
} from "./protocol";
import type { TabEvidence } from "./tab-evidence";

export interface BrowserTaskSessionIdentity {
  id: string;
  title: string;
}

export interface BrowserSessionPageContext {
  tab_id: number;
  url: string;
  title: string;
}

export interface BrowserSessionTargetEvidence {
  element_id: string;
  semantic_ref?: string;
  tag: string;
  role: string;
  accessible_name: string;
  type?: string;
  requires_approval?: boolean;
  approval_reason?: string;
  enter_requires_approval?: boolean;
}

export interface BrowserSessionDelegationWorkerEvidence {
  index: number;
  task: string;
  session_id: string;
  status:
    | "completed"
    | "stopped"
    | "approval-cancelled"
    | "failed";
  sources: Array<{
    url: string;
    title: string;
  }>;
  tools_used: string[];
}

/** One node of a Task DAG as it ended (Phase 8). Read-only, like every DAG worker. */
export interface BrowserSessionDagNodeEvidence {
  node_id: string;
  type: "research" | "verify";
  task: string;
  /** The scheduler's end state. A node never started has no session, sources or verdict. */
  status: "completed" | "failed" | "blocked" | "cancelled";
  /** The worker's own end state when it ran ("stopped" at its step limit, for example). */
  worker_status?: BrowserSessionDelegationWorkerEvidence["status"];
  child_session_id?: string;
  /** The nodes this one built on or checked, in the order given. */
  depends_on: string[];
  blocked_by?: string;
  sources: Array<{ url: string; title: string }>;
  tools_used: string[];
  /** Verify nodes that completed only. */
  verdict?: "supported" | "contradicted" | "insufficient";
  /** A short, checked summary of what the worker concluded: a model's reading, not a page. */
  finding?: string;
}

export interface BrowserSessionDagEvidence {
  nodes: BrowserSessionDagNodeEvidence[];
  completed_count: number;
  failed_count: number;
  blocked_count: number;
  cancelled_count: number;
  cancelled: boolean;
}

export interface BrowserSessionDelegationEvidence {
  /** "batch": parallel helpers; "dag": a Task DAG. Missing on older records, which are batches. */
  kind?: "batch" | "dag";
  /** Batches only: "read" workers or "act" helpers, as launched. Missing on older records. */
  mode?: "read" | "act";
  worker_count: number;
  completed_count: number;
  non_completed_count: number;
  /** Batch workers. Empty for a DAG, whose work is in `dag`. */
  workers: BrowserSessionDelegationWorkerEvidence[];
  dag?: BrowserSessionDagEvidence;
}

export interface BrowserSessionActionEvidence {
  id: string;
  ordinal: number;
  recorded_at: string;
  tool: ToolName;
  input: Record<string, unknown>;
  note: string;
  before: BrowserSessionPageContext;
  target?: BrowserSessionTargetEvidence;
  approval: {
    required: boolean;
    approved: boolean;
    description?: string;
  };
  result_tab_id?: number;
  delegation?: BrowserSessionDelegationEvidence;
  after?: BrowserSessionPageContext;
}

export interface BrowserSessionManualHandoffEvidence {
  id: string;
  recorded_at: string;
  reason: string;
  status: "continued" | "cancelled";
  source: "navigation" | "user";
  before: BrowserSessionPageContext;
  after?: BrowserSessionPageContext;
}

export interface BrowserTaskSessionEvidence {
  version: 1;
  session_id: string;
  title: string;
  task: string;
  started_at: string;
  status: "completed" | "stopped" | "approval-cancelled";
  start: BrowserSessionPageContext;
  actions: BrowserSessionActionEvidence[];
  manual_handoffs?: BrowserSessionManualHandoffEvidence[];
  boundary_action_id?: string;
  tab_evidence: TabEvidence[];
}

export function pageContext(
  observation: PageObservation
): BrowserSessionPageContext {
  return {
    tab_id: observation.tab_id,
    url: observation.url,
    title: observation.title
  };
}

export function targetEvidence(
  observation: PageObservation,
  elementId: unknown
): BrowserSessionTargetEvidence | undefined {
  if (typeof elementId !== "string") return undefined;

  const element = observation.elements.find(
    (candidate) =>
      candidate.element_id === elementId ||
      candidate.semantic_ref === elementId
  );

  return element ? copyTarget(element) : undefined;
}

function copyTarget(
  element: InteractiveElement
): BrowserSessionTargetEvidence {
  return {
    element_id: element.element_id,
    ...(element.semantic_ref
      ? { semantic_ref: element.semantic_ref }
      : {}),
    tag: element.tag,
    role: element.role,
    accessible_name: element.accessible_name,
    ...(element.type ? { type: element.type } : {}),
    ...(element.requires_approval
      ? { requires_approval: true }
      : {}),
    ...(element.approval_reason
      ? { approval_reason: element.approval_reason }
      : {}),
    ...(element.enter_requires_approval
      ? { enter_requires_approval: true }
      : {})
  };
}

export function copySessionInput(
  input: Record<string, unknown>
): Record<string, unknown> {
  return structuredClone(input);
}
