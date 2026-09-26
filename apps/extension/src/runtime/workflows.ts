export interface WorkflowLocator {
  tag: string;
  role: string;
  accessible_name: string;
  input_type?: string;
}

export type RecordedWorkflowStep =
  | { action: "click"; locator: WorkflowLocator }
  | { action: "type"; locator: WorkflowLocator; text: string };

export interface SavedWorkflow {
  id: string;
  name: string;
  created_at: string;
  url: string;
  steps: RecordedWorkflowStep[];
}

const KEY = "browsercrew.workflows";

export async function loadWorkflows(): Promise<SavedWorkflow[]> {
  const stored = await chrome.storage.local.get(KEY);
  return Array.isArray(stored[KEY]) ? (stored[KEY] as SavedWorkflow[]) : [];
}

export async function saveWorkflow(workflow: SavedWorkflow): Promise<void> {
  const current = await loadWorkflows();
  await chrome.storage.local.set({
    [KEY]: [workflow, ...current.filter((item) => item.id !== workflow.id)].slice(0, 50)
  });
}
