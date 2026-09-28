import {
  captureAxSnapshot,
  type AxSemanticElement
} from "../background/cdp-semantic";
import {
  trustedClick,
  trustedKey,
  trustedType
} from "../background/cdp-input";
import { selectOptions } from "../background/cdp-select";
import { uploadFiles } from "../background/file-tools";
import type {
  SiteCandidateSkill,
  SiteSkillParameter,
  SiteSkillRecipe,
  SiteSkillTarget
} from "./site-skill";

export interface SiteSkillRunResult {
  recipe_id: string;
  executed_steps: number;
  submitted: boolean;
}

function normalized(value: string | undefined): string {
  return (value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function equivalentRole(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  const textRoles = new Set(["textbox", "searchbox"]);
  return textRoles.has(expected) && textRoles.has(actual);
}

export function resolveSiteSkillTarget(
  elements: AxSemanticElement[],
  target: SiteSkillTarget
): AxSemanticElement {
  const expectedName = normalized(target.accessible_name);
  const expectedRole = normalized(target.role);
  const fallbackHints = [
    target.selector_hints.name,
    target.selector_hints.id
  ]
    .map(normalized)
    .filter(Boolean);

  const ranked = elements
    .map((element) => {
      let score = 0;
      const name = normalized(element.name);
      const role = normalized(element.role);

      if (expectedRole) {
        if (!equivalentRole(expectedRole, role)) return null;
        score += 30;
      }

      if (expectedName) {
        if (name === expectedName) score += 100;
        else if (
          name.includes(expectedName) ||
          expectedName.includes(name)
        ) {
          score += 50;
        } else {
          return null;
        }
      } else if (
        fallbackHints.some(
          (hint) => name === hint || name.includes(hint)
        )
      ) {
        score += 40;
      } else if (!expectedRole) {
        return null;
      }

      if (element.disabled) score -= 1000;
      return { element, score };
    })
    .filter(
      (
        item
      ): item is { element: AxSemanticElement; score: number } =>
        Boolean(item)
    )
    .sort((left, right) => right.score - left.score);

  if (!ranked.length || ranked[0].score < 0) {
    throw new Error(
      `SITE_SKILL_TARGET_NOT_FOUND: ${target.accessible_name || target.role || "target"}`
    );
  }

  if (
    ranked.length > 1 &&
    ranked[0].score === ranked[1].score
  ) {
    throw new Error(
      `SITE_SKILL_TARGET_AMBIGUOUS: ${target.accessible_name || target.role || "target"}`
    );
  }

  return ranked[0].element;
}

export function selectSiteSkillRecipe(
  candidate: SiteCandidateSkill,
  recipeId?: string
): SiteSkillRecipe {
  if (recipeId) {
    const recipe = candidate.recipes.find(
      (item) => item.id === recipeId
    );
    if (!recipe) {
      throw new Error("SITE_SKILL_RECIPE_NOT_FOUND");
    }
    return recipe;
  }

  if (candidate.recipes.length !== 1) {
    throw new Error(
      "SITE_SKILL_RECIPE_REQUIRED: candidate has multiple recipes"
    );
  }
  return candidate.recipes[0];
}

function parameterDefinition(
  candidate: SiteCandidateSkill,
  name: string
): SiteSkillParameter {
  const parameter = candidate.parameters.find(
    (item) => item.name === name
  );
  if (!parameter) {
    throw new Error(
      `SITE_SKILL_PARAMETER_NOT_FOUND: ${name}`
    );
  }
  return parameter;
}

function validateParameterValue(
  parameter: SiteSkillParameter,
  value: unknown
): void {
  if (value === undefined) {
    if (parameter.required) {
      throw new Error(
        `SITE_SKILL_PARAMETER_REQUIRED: ${parameter.name}`
      );
    }
    return;
  }

  if (parameter.type === "string" && typeof value !== "string") {
    throw new Error(
      `SITE_SKILL_PARAMETER_TYPE: ${parameter.name} must be string`
    );
  }
  if (
    parameter.type === "string[]" &&
    (!Array.isArray(value) ||
      value.some((item) => typeof item !== "string"))
  ) {
    throw new Error(
      `SITE_SKILL_PARAMETER_TYPE: ${parameter.name} must be string[]`
    );
  }
  if (parameter.type === "boolean" && typeof value !== "boolean") {
    throw new Error(
      `SITE_SKILL_PARAMETER_TYPE: ${parameter.name} must be boolean`
    );
  }
}

async function freshTarget(
  tabId: number,
  target: SiteSkillTarget
): Promise<AxSemanticElement> {
  const snapshot = await captureAxSnapshot(tabId, 1000);
  return resolveSiteSkillTarget(snapshot.elements, target);
}

export async function runSiteSkillRecipe(input: {
  tab_id: number;
  candidate: SiteCandidateSkill;
  recipe_id?: string;
  parameters: Record<string, unknown>;
}): Promise<SiteSkillRunResult> {
  const recipe = selectSiteSkillRecipe(
    input.candidate,
    input.recipe_id
  );

  for (const parameterName of recipe.parameters) {
    validateParameterValue(
      parameterDefinition(input.candidate, parameterName),
      input.parameters[parameterName]
    );
  }

  let executedSteps = 0;
  let submitted = false;

  for (const step of recipe.steps) {
    if (step.kind === "input") {
      const parameter = parameterDefinition(
        input.candidate,
        step.parameter
      );
      const value = input.parameters[step.parameter];

      if (value === undefined && !parameter.required) {
        continue;
      }

      const target = await freshTarget(input.tab_id, step.target);

      if (step.input_mode === "type") {
        await trustedType(
          input.tab_id,
          target.element_id,
          String(value)
        );
      } else if (step.input_mode === "select") {
        const values = Array.isArray(value)
          ? (value as string[])
          : [String(value)];
        await selectOptions(
          input.tab_id,
          target.element_id,
          values
        );
      } else if (step.input_mode === "upload") {
        await uploadFiles(
          input.tab_id,
          target.element_id,
          value as string[]
        );
      } else {
        if (typeof value !== "boolean") {
          throw new Error(
            `SITE_SKILL_PARAMETER_TYPE: ${step.parameter} must be boolean`
          );
        }
        if (target.checked === "mixed" || target.checked === undefined) {
          throw new Error(
            `SITE_SKILL_TOGGLE_STATE_UNAVAILABLE: ${step.parameter}`
          );
        }
        if (target.checked !== value) {
          await trustedClick(input.tab_id, target.element_id);
        }
      }

      executedSteps += 1;
      continue;
    }

    if (step.target) {
      const target = await freshTarget(input.tab_id, step.target);
      await trustedClick(input.tab_id, target.element_id);
    } else {
      await trustedKey(input.tab_id, "Enter");
    }
    executedSteps += 1;
    submitted = true;
  }

  return {
    recipe_id: recipe.id,
    executed_steps: executedSteps,
    submitted
  };
}
