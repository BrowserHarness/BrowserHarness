import { describe, expect, it } from "vitest";
import { renderIntentPrompt, workflowToIntentSkill } from "./intent-skill";
import type { SavedWorkflow, WorkflowLocator } from "./workflows";

const loc = (name: string, extra: Partial<WorkflowLocator> = {}): WorkflowLocator => ({
  tag: "input",
  role: "textbox",
  accessible_name: name,
  ...extra
});

const workflow = (): SavedWorkflow => ({
  id: "w1",
  name: "Sign up",
  created_at: "2026-10-04",
  url: "https://example.com/signup",
  inputs: [{ name: "email", label: "Email", default: "a@b.com", step_id: "s2" }],
  steps: [
    { id: "s1", action: "click", locator: loc("Email") },
    { id: "s1b", action: "click", locator: loc("Email") },
    { id: "s2a", action: "type", text: "a", locator: loc("Email") },
    { id: "s2", action: "type", text: "a@b.com", locator: loc("Email") },
    { id: "s3", action: "type", text: "hunter2", locator: loc("Password", { input_type: "password" }) },
    { id: "s4", action: "key", key: "Shift" },
    {
      id: "s5",
      action: "click",
      locator: { tag: "button", role: "button", accessible_name: "Create account", requires_approval: true, approval_reason: "Creates an account" }
    }
  ]
});

describe("workflowToIntentSkill", () => {
  it("drops backtracking, uses placeholders, flags secrets and irreversible steps", () => {
    const skill = workflowToIntentSkill(workflow());
    expect(skill.dropped_steps).toBe(3);
    expect(skill.steps).toEqual([
      "Click “Email” (textbox)",
      "Enter {{email}} into “Email”",
      "Enter {{input_2}} into “Password”",
      "Click “Create account” (button)"
    ]);
    expect(skill.inputs.find((i) => i.name === "input_2")).toMatchObject({ secret: true, default: "" });
    expect(JSON.stringify(skill)).not.toContain("hunter2");
    expect(skill.irreversible_steps[0]).toContain("Creates an account");
  });

  it("renders a prompt that fills known values and never invents secrets", () => {
    const skill = workflowToIntentSkill(workflow());
    const prompt = renderIntentPrompt(skill, { email: "me@x.com" });
    expect(prompt).toContain("Enter me@x.com into “Email”");
    expect(prompt).toContain("{{input_2}}");
    expect(prompt).toContain("secret: ask the user");
    expect(prompt).toContain("get approval before");
  });
});
