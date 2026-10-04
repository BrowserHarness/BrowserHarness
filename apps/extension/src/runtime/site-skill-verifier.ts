import type {
  SiteCandidateSkill,
  SiteSkillEvidence,
  SiteSkillRecipeStep
} from "./site-skill";

export interface SiteSkillVerificationCheck {
  id: string;
  passed: boolean;
  kind:
    | "origin"
    | "form"
    | "field"
    | "submit";
  detail: string;
}

export interface SiteSkillVerificationResult {
  status: "verified" | "failed";
  verified_at: string;
  evidence_id: string;
  url: string;
  checks: SiteSkillVerificationCheck[];
}

function normalized(value: string | undefined): string {
  return (value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function inputSteps(
  candidate: SiteCandidateSkill
): Array<Extract<SiteSkillRecipeStep, { kind: "input" }>> {
  return candidate.recipes.flatMap((recipe) =>
    recipe.steps.filter(
      (
        step
      ): step is Extract<SiteSkillRecipeStep, { kind: "input" }> =>
        step.kind === "input"
    )
  );
}

export function verifySiteSkillCandidate(
  candidate: SiteCandidateSkill,
  evidence: SiteSkillEvidence,
  verifiedAt = new Date().toISOString()
): SiteSkillVerificationResult {
  const checks: SiteSkillVerificationCheck[] = [];

  checks.push({
    id: "origin",
    passed: evidence.site.origin === candidate.site.origin,
    kind: "origin",
    detail: `Expected ${candidate.site.origin}; observed ${evidence.site.origin}`
  });

  for (const recipe of candidate.recipes) {
    // API recipes have no form; their contract is the origin check above plus a live fetch at run time.
    if (recipe.form_index < 0) continue;
    const observedForm = evidence.forms.find(
      (form) => form.index === recipe.form_index
    );
    const formPassed = Boolean(
      observedForm &&
        normalized(observedForm.method) === normalized(recipe.method) &&
        normalized(observedForm.action) === normalized(recipe.action)
    );

    checks.push({
      id: `form-${recipe.form_index}`,
      passed: formPassed,
      kind: "form",
      detail: formPassed
        ? `Form ${recipe.form_index + 1} action/method match`
        : `Form ${recipe.form_index + 1} action/method changed or disappeared`
    });

    if (!observedForm) continue;

    for (const step of inputSteps({
      ...candidate,
      recipes: [recipe]
    })) {
      const expectedName = normalized(step.target.selector_hints.name);
      const expectedId = normalized(step.target.selector_hints.id);
      const expectedLabel = normalized(step.target.accessible_name);
      const expectedType = normalized(step.target.input_type);

      const observed = observedForm.fields.find((field) => {
        if (expectedId && normalized(field.id) === expectedId) return true;
        if (expectedName && normalized(field.name) === expectedName) {
          return true;
        }
        if (
          expectedLabel &&
          normalized(field.accessible_name) === expectedLabel
        ) {
          return true;
        }
        return false;
      });

      const passed = Boolean(
        observed &&
          (!expectedType ||
            normalized(observed.type) === expectedType)
      );

      checks.push({
        id: `field-${recipe.form_index}-${step.parameter}`,
        passed,
        kind: "field",
        detail: passed
          ? `Resolved parameter ${step.parameter} to fresh field evidence`
          : `Could not resolve parameter ${step.parameter} to the expected fresh field`
      });
    }

    const submitStep = recipe.steps.find(
      (step): step is Extract<SiteSkillRecipeStep, { kind: "submit" }> =>
        step.kind === "submit"
    );
    if (submitStep?.target) {
      const expectedLabel = normalized(
        submitStep.target.accessible_name
      );
      const expectedId = normalized(
        submitStep.target.selector_hints.id
      );
      const submitPassed = Boolean(
        observedForm.submit &&
          ((expectedId &&
            normalized(observedForm.submit.id) === expectedId) ||
            (expectedLabel &&
              normalized(observedForm.submit.accessible_name) ===
                expectedLabel))
      );
      checks.push({
        id: `submit-${recipe.form_index}`,
        passed: submitPassed,
        kind: "submit",
        detail: submitPassed
          ? "Submit target resolved from fresh evidence"
          : "Submit target changed or disappeared"
      });
    }
  }

  return {
    status: checks.every((check) => check.passed)
      ? "verified"
      : "failed",
    verified_at: verifiedAt,
    evidence_id: evidence.evidence_id,
    url: evidence.site.url,
    checks
  };
}
