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
