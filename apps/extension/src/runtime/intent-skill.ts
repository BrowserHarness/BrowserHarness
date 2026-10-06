import { SECRET_FIELD_NAME } from "./memory-write/sensitivity";
import type {
  RecordedWorkflowStep,
  SavedWorkflow,
  WorkflowLocator
} from "./workflows";

export interface IntentSkillInput {
  name: string;
  label: string;
  secret: boolean;
  default: string;
}

export interface IntentSkill {
  name: string;
  start_url: string;
  inputs: IntentSkillInput[];
  steps: string[];
  irreversible_steps: string[];
  dropped_steps: number;
}

// One list of secret field names, shared with the memory safety check.
const SECRET_NAME = SECRET_FIELD_NAME;

function label(locator: WorkflowLocator | undefined): string {
  const name =
    locator?.accessible_name ||
    locator?.label ||
    locator?.element_text ||
    "";
  const text = name.replace(/\s+/g, " ").trim().slice(0, 60);
  return text ? `“${text}”` : "the control";
}

function sameTarget(
  a: RecordedWorkflowStep,
  b: RecordedWorkflowStep
): boolean {
  if (!("locator" in a) || !("locator" in b)) return false;
  if (!a.locator || !b.locator) return false;
  return (
    a.locator.role === b.locator.role &&
    a.locator.accessible_name === b.locator.accessible_name &&
    a.locator.tag === b.locator.tag
  );
}

function needsApproval(step: RecordedWorkflowStep): boolean {
  if (!("locator" in step) || !step.locator) return false;
  return Boolean(
    step.locator.requires_approval ||
      step.locator.enter_requires_approval
  );
}

/**
 * Deterministic distillation of a recording into intent steps with {{placeholders}}.
 * Drops repeated typing into one field (keeps the last), double clicks on the same target,
 * and stray key presses other than Enter. Secrets never get their recorded value.
 */
export function workflowToIntentSkill(
  workflow: SavedWorkflow
): IntentSkill {
  const inputsByStep = new Map(
    (workflow.inputs || [])
      .filter((input) => input.step_id)
      .map((input) => [input.step_id as string, input])
  );

  const kept: RecordedWorkflowStep[] = [];
  let dropped = 0;
  for (const step of workflow.steps) {
    const prev = kept[kept.length - 1];
    if (step.action === "key" && step.key !== "Enter") {
      dropped += 1;
      continue;
    }
    if (
      prev &&
      step.action === "type" &&
      prev.action === "type" &&
      sameTarget(prev, step)
    ) {
      kept[kept.length - 1] = step;
      dropped += 1;
      continue;
    }
    if (
      prev &&
      step.action === "click" &&
      prev.action === "click" &&
      sameTarget(prev, step)
    ) {
      dropped += 1;
      continue;
    }
    kept.push(step);
  }

  const inputs: IntentSkillInput[] = [];
  const steps: string[] = [];
  const irreversible: string[] = [];

  for (const step of kept) {
    let text: string;
    if (step.action === "type") {
      const known = step.id ? inputsByStep.get(step.id) : undefined;
      const secret =
        step.locator.input_type === "password" ||
        SECRET_NAME.test(step.locator.accessible_name || "") ||
        SECRET_NAME.test(known?.name || "");
      const name =
        known?.name ||
        `input_${inputs.length + 1}`;
      if (!inputs.some((item) => item.name === name)) {
        inputs.push({
          name,
          label: known?.label || step.locator.accessible_name || name,
          secret,
          default: secret ? "" : known?.default ?? step.text
        });
      }
      text = `Enter {{${name}}} into ${label(step.locator)}`;
    } else if (step.action === "click") {
      text = `Click ${label(step.locator)}${step.locator.role ? ` (${step.locator.role})` : ""}`;
    } else {
      text = `Press ${step.key}${step.locator ? ` in ${label(step.locator)}` : ""}`;
    }
    steps.push(text);
    if (needsApproval(step)) {
      irreversible.push(
        `${text} — ${
          ("locator" in step && step.locator?.approval_reason) ||
          "may be irreversible"
        }`
      );
    }
  }

  return {
    name: workflow.name,
    start_url: workflow.url,
    inputs,
    steps,
    irreversible_steps: irreversible,
    dropped_steps: dropped
  };
}

export function renderIntentPrompt(
  skill: IntentSkill,
  values: Record<string, string> = {}
): string {
  const resolve = (text: string) =>
    text.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
      const input = skill.inputs.find((item) => item.name === name);
      const value = values[name] ?? (input && !input.secret ? input.default : "");
      return value || match;
    });

  const lines = [
    `Repeat the task "${skill.name}" by intent, starting at ${skill.start_url}.`,
    "The steps below were demonstrated once; adapt if the page differs, and re-read the page after each step.",
    ...(skill.inputs.length
      ? [
          "Inputs:",
          ...skill.inputs.map(
            (input) =>
              `- {{${input.name}}} (${input.label})${input.secret ? " — secret: ask the user; never guess or invent" : ""}`
          )
        ]
      : []),
    "Steps:",
    ...skill.steps.map((step, index) => `${index + 1}. ${resolve(step)}`),
    ...(skill.irreversible_steps.length
      ? [
          "Irreversible or sensitive steps: stop and get approval before:",
          ...skill.irreversible_steps.map((step) => `- ${resolve(step)}`)
        ]
      : [])
  ];
  return lines.join("\n");
}
