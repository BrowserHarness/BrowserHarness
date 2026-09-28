import type {
  SiteCandidateSkill,
  SiteSkillParameter,
  SiteSkillRecipe
} from "./site-skill";

export interface SiteSkillContractDiff {
  changed: boolean;
  parameters: {
    added: string[];
    removed: string[];
    changed: string[];
  };
  recipes: {
    added: string[];
    removed: string[];
    changed: string[];
  };
}

function parameterSignature(parameter: SiteSkillParameter): string {
  return JSON.stringify({
    label: parameter.label,
    type: parameter.type,
    required: parameter.required,
    sensitive: parameter.sensitive,
    source: parameter.source,
    options: parameter.options || []
  });
}

function recipeSignature(recipe: SiteSkillRecipe): string {
  return JSON.stringify({
    name: recipe.name,
    entry_url: recipe.entry_url,
    form_index: recipe.form_index,
    method: recipe.method,
    action: recipe.action,
    parameters: recipe.parameters,
    steps: recipe.steps,
    verification: recipe.verification
  });
}

function diffNamed<T extends { name?: string; id?: string }>(
  previous: T[],
  next: T[],
  key: (item: T) => string,
  signature: (item: T) => string
): {
  added: string[];
  removed: string[];
  changed: string[];
} {
  const before = new Map(previous.map((item) => [key(item), item]));
  const after = new Map(next.map((item) => [key(item), item]));

  const added = [...after.keys()]
    .filter((name) => !before.has(name))
    .sort();
  const removed = [...before.keys()]
    .filter((name) => !after.has(name))
    .sort();
  const changed = [...after.keys()]
    .filter((name) => {
      const left = before.get(name);
      const right = after.get(name);
      return Boolean(
        left &&
          right &&
          signature(left) !== signature(right)
      );
    })
    .sort();

  return { added, removed, changed };
}

export function compareSiteSkillContracts(
  previous: SiteCandidateSkill,
  next: SiteCandidateSkill
): SiteSkillContractDiff {
  if (previous.site.origin !== next.site.origin) {
    throw new Error(
      `SITE_SKILL_REFINEMENT_ORIGIN_MISMATCH: expected ${previous.site.origin}; observed ${next.site.origin}`
    );
  }

  const parameters = diffNamed(
    previous.parameters,
    next.parameters,
    (item) => item.name,
    parameterSignature
  );
  const recipes = diffNamed(
    previous.recipes,
    next.recipes,
    (item) => item.id,
    recipeSignature
  );

  const changed =
    parameters.added.length > 0 ||
    parameters.removed.length > 0 ||
    parameters.changed.length > 0 ||
    recipes.added.length > 0 ||
    recipes.removed.length > 0 ||
    recipes.changed.length > 0;

  return {
    changed,
    parameters,
    recipes
  };
}

export function createRefinedSiteSkillCandidate(
  previous: SiteCandidateSkill,
  fresh: SiteCandidateSkill
): {
  candidate: SiteCandidateSkill;
  diff: SiteSkillContractDiff;
} {
  const diff = compareSiteSkillContracts(previous, fresh);

  return {
    candidate: {
      ...structuredClone(fresh),
      id: previous.id,
      slug: previous.slug,
      name: previous.name,
      version: previous.version,
      status: "candidate",
      lifecycle: {
        auto_promote: false,
        promotion_requires_evaluation: true
      }
    },
    diff
  };
}
