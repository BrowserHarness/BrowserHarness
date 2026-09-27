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

export interface WorkflowInput {
  name: string;
  label: string;
  default: string;
  step_id?: string;
}

export interface SavedWorkflow {
  id: string;
  version?: 2;
  name: string;
  created_at: string;
  url: string;
  end_url?: string;
  inputs?: WorkflowInput[];
  steps: RecordedWorkflowStep[];
}

const KEY = "browsercrew.workflows";

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
  const target =
    "locator" in step
      ? step.locator.accessible_name ||
        step.locator.label ||
        step.locator.role
      : "";

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
