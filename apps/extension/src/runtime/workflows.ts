export interface WorkflowLocator {
  tag: string;
  role: string;
  accessible_name: string;
  semantic_ref?: string;
  label?: string;
  element_text?: string;
  attributes?: Record<string, string>;
  input_type?: string;
  requires_approval?: boolean;
  approval_reason?: string;
  enter_requires_approval?: boolean;
}

export interface RecordedStepContext {
  id?: string;
  recorded_at?: string;
  url?: string;
  title?: string;
  scroll_x?: number;
  scroll_y?: number;
  description?: string;
  tab_id?: number;
}

export type RecordedWorkflowStep =
  | (RecordedStepContext & {
      action: "click";
      locator: WorkflowLocator;
      pointer?: { x: number; y: number };
    })
  | (RecordedStepContext & {
      action: "type";
      locator: WorkflowLocator;
      text: string;
    })
  | (RecordedStepContext & {
      action: "key";
      key: string;
      locator?: WorkflowLocator;
    });

export type WorkflowRecordingEvent =
  | {
      id: string;
      type: "navigation";
      recorded_at: string;
      tab_id: number;
      url: string;
      transition_type?: string;
      transition_qualifiers?: string[];
    }
  | {
      id: string;
      type: "tab_opened";
      recorded_at: string;
      tab_id: number;
      opener_tab_id?: number;
      url?: string;
      title?: string;
    }
  | {
      id: string;
      type: "tab_activated";
      recorded_at: string;
      tab_id: number;
      window_id: number;
      url?: string;
      title?: string;
    }
  | {
      id: string;
      type: "tab_closed";
      recorded_at: string;
      tab_id: number;
    };

export interface WorkflowRecordingSummary {
  tab_count: number;
  event_count: number;
  dropped_steps: number;
  dropped_events: number;
  approximate_bytes: number;
}

export interface WorkflowInput {
  name: string;
  label: string;
  default: string;
  step_id?: string;
}

export interface SavedWorkflow {
  id: string;
  version?: 2 | 3;
  name: string;
  created_at: string;
  url: string;
  end_url?: string;
  inputs?: WorkflowInput[];
  steps: RecordedWorkflowStep[];
  events?: WorkflowRecordingEvent[];
  boundary_step_id?: string;
  recording?: WorkflowRecordingSummary;
}

const KEY = "browserharness.workflows";

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return normalized || "input";
}

export function inferWorkflowInputs(
  steps: RecordedWorkflowStep[]
): WorkflowInput[] {
  const used = new Map<string, number>();
  const inputs: WorkflowInput[] = [];

  for (const step of steps) {
    if (step.action !== "type" || !step.text) continue;

    const label =
      step.locator.label ||
      step.locator.accessible_name ||
      step.locator.attributes?.placeholder ||
      step.locator.attributes?.name ||
      "Input";

    const base = slug(label);
    const nextCount = (used.get(base) || 0) + 1;
    used.set(base, nextCount);
    const name =
      nextCount === 1 ? base : `${base}_${nextCount}`;

    inputs.push({
      name,
      label,
      default: step.text,
      step_id: step.id
    });
  }

  return inputs;
}

export function describeWorkflowStep(
  step: RecordedWorkflowStep
): string {
  const locator = step.locator;
  const target =
    locator?.accessible_name ||
    locator?.label ||
    locator?.role ||
    "";

  if (step.action === "click") {
    return `Click ${target || "the recorded control"}`;
  }

  if (step.action === "type") {
    return `Enter text in ${target || "the recorded field"}`;
  }

  return `Press ${step.key}${target ? ` in ${target}` : ""}`;
}

export function finalizeRecordedSteps(
  steps: RecordedWorkflowStep[]
): RecordedWorkflowStep[] {
  return steps.map((step) => ({
    ...step,
    description: step.description || describeWorkflowStep(step)
  }));
}

export async function loadWorkflows(): Promise<SavedWorkflow[]> {
  const stored = await chrome.storage.local.get(KEY);
  return Array.isArray(stored[KEY])
    ? (stored[KEY] as SavedWorkflow[])
    : [];
}

export async function saveWorkflow(
  workflow: SavedWorkflow
): Promise<void> {
  const current = await loadWorkflows();
  await chrome.storage.local.set({
    [KEY]: [
      workflow,
      ...current.filter((item) => item.id !== workflow.id)
    ].slice(0, 50)
  });
}

export async function deleteWorkflow(id: string): Promise<void> {
  const current = await loadWorkflows();
  await chrome.storage.local.set({
    [KEY]: current.filter((item) => item.id !== id)
  });
}

export async function renameWorkflow(
  id: string,
  name: string
): Promise<void> {
  const clean = name.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!clean) return;
  const current = await loadWorkflows();
  await chrome.storage.local.set({
    [KEY]: current.map((item) =>
      item.id === id ? { ...item, name: clean } : item
    )
  });
}
