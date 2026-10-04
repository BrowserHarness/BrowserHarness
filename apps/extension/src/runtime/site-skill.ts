import type { AxSnapshot } from "../background/cdp-semantic";
import type { NetworkRecord } from "../background/network-capture";
import { deriveApiRecipes } from "./site-skill-api";

export interface SiteFormFieldEvidence {
  tag: string;
  type: string;
  name: string;
  id?: string;
  accessible_name: string;
  required: boolean;
  max_length?: number;
  autocomplete?: string;
  placeholder?: string;
  options?: string[];
}

export interface SiteFormEvidence {
  index: number;
  id?: string;
  name?: string;
  action: string;
  method: string;
  fields: SiteFormFieldEvidence[];
  submit?: {
    accessible_name: string;
    id?: string;
    name?: string;
  };
}

export interface SiteNetworkEvidence {
  request_id: string;
  method: string;
  url: string;
  status?: number;
  mime_type?: string;
  header_names: string[];
  post_data_keys: string[];
}

export interface SiteSkillEvidence {
  schema_version: 1;
  evidence_id: string;
  captured_at: string;
  site: {
    url: string;
    origin: string;
    title: string;
  };
  ax: {
    target_count: number;
    targets: Array<{
      role: string;
      name: string;
      disabled: boolean;
    }>;
  };
  forms: SiteFormEvidence[];
  network: SiteNetworkEvidence[];
}

export type SiteSkillParameterType =
  | "string"
  | "string[]"
  | "boolean";

export interface SiteSkillParameter {
  name: string;
  label: string;
  type: SiteSkillParameterType;
  required: boolean;
  sensitive: boolean;
  source: {
    form_index: number;
    field_name: string;
  };
  options?: string[];
}

export interface SiteSkillTarget {
  role?: string;
  accessible_name?: string;
  tag?: string;
  input_type?: string;
  selector_hints: {
    id?: string;
    name?: string;
  };
  resolution: "fresh_semantic_then_dom_hint";
}

export type SiteSkillRecipeStep =
  | {
      kind: "input";
      form_index: number;
      input_mode: "type" | "select" | "upload" | "toggle";
      parameter: string;
      target: SiteSkillTarget;
    }
  | {
      kind: "submit";
      form_index: number;
      target?: SiteSkillTarget;
      method: string;
      action: string;
      approval: "browsercrew_runtime";
    }
  | {
      kind: "api_fetch";
      method: "GET";
      /** Same-origin path; never an absolute URL. */
      path: string;
      query: Array<{
        key: string;
        parameter: string;
        default?: string;
      }>;
      response: {
        format: "json" | "text";
        max_chars: number;
      };
      approval: "none_read_only";
    };

export interface SiteSkillRecipe {
  id: string;
  name: string;
  entry_url: string;
  form_index: number;
  method: string;
  action: string;
  parameters: string[];
  steps: SiteSkillRecipeStep[];
  verification: {
    required: true;
    checks: Array<{
      kind: "form_present" | "field_present" | "submit_target";
      expect: Record<string, unknown>;
    }>;
  };
}

export interface SiteCandidateSkill {
  schema_version: 1;
  id: string;
  slug: string;
  name: string;
  version: "0.1.0";
  status: "candidate";
  lifecycle: {
    auto_promote: false;
    promotion_requires_evaluation: true;
  };
  site: {
    origin: string;
    entry_url: string;
    title: string;
  };
  parameters: SiteSkillParameter[];
  recipes: SiteSkillRecipe[];
  network_candidates: SiteNetworkEvidence[];
  safety: {
    execution_requires_fresh_resolution: true;
    approval_policy: "preserve_browsercrew_approval_rules";
    structural_analysis_is_not_execution_proof: true;
  };
  provenance: {
    source_kind: "site_analysis_v1";
    evidence_id: string;
    captured_at: string;
    ax_target_count: number;
    form_count: number;
    network_request_count: number;
  };
  verification?: {
    status: "verified" | "failed";
    verified_at: string;
    evidence_id: string;
    url: string;
    checks: Array<{
      id: string;
      passed: boolean;
      kind: "origin" | "form" | "field" | "submit";
      detail: string;
    }>;
  };
}

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || "site";
}

function parameterBase(field: SiteFormFieldEvidence): string {
  return slug(
    field.name || field.accessible_name || field.type || field.tag
  ).replace(/-/g, "_");
}

function uniqueName(base: string, used: Map<string, number>): string {
  const safe = base || "input";
  const count = (used.get(safe) || 0) + 1;
  used.set(safe, count);
  return count === 1 ? safe : `${safe}_${count}`;
}

function fieldParameterType(
  field: SiteFormFieldEvidence
): SiteSkillParameterType {
  if (field.type === "file") return "string[]";
  if (field.type === "checkbox" || field.type === "radio") {
    return "boolean";
  }
  return "string";
}

function fieldInputMode(
  field: SiteFormFieldEvidence
): Extract<SiteSkillRecipeStep, { kind: "input" }>["input_mode"] {
  if (field.type === "file") return "upload";
  if (field.tag === "select") return "select";
  if (field.type === "checkbox" || field.type === "radio") {
    return "toggle";
  }
  return "type";
}

function targetForField(
  field: SiteFormFieldEvidence
): SiteSkillTarget {
  return {
    ...(field.accessible_name
      ? { accessible_name: field.accessible_name }
      : {}),
    role:
      field.tag === "select"
        ? "combobox"
        : field.type === "checkbox"
          ? "checkbox"
          : field.type === "radio"
            ? "radio"
            : "textbox",
    tag: field.tag,
    input_type: field.type,
    selector_hints: {
      ...(field.id ? { id: field.id } : {}),
      ...(field.name ? { name: field.name } : {})
    },
    resolution: "fresh_semantic_then_dom_hint"
  };
}

function postDataKeys(postData?: string): string[] {
  if (!postData) return [];
  try {
    const parsed = JSON.parse(postData);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return Object.keys(parsed).slice(0, 50).sort();
    }
  } catch {
    // Fall through to URL-encoded/key=value inspection.
  }

  try {
    const params = new URLSearchParams(postData);
    const keys = [...new Set([...params.keys()])];
    if (keys.length) return keys.slice(0, 50).sort();
  } catch {
    // Unsupported body shape; retain no values.
  }

  return [];
}

export function summarizeSiteNetworkEvidence(
  records: NetworkRecord[],
  limit = 50
): SiteNetworkEvidence[] {
  return records
    .slice(-Math.min(Math.max(limit, 1), 100))
    .map((record) => ({
      request_id: record.request_id,
      method: record.method,
      url: record.url,
      ...(typeof record.status === "number"
        ? { status: record.status }
        : {}),
      ...(record.mime_type ? { mime_type: record.mime_type } : {}),
      header_names: Object.keys(record.request_headers || {})
        .map((name) => name.toLowerCase())
        .sort(),
      post_data_keys: postDataKeys(record.post_data)
    }));
}

export function createSiteSkillEvidence(input: {
  evidence_id: string;
  captured_at: string;
  url: string;
  title: string;
  ax: AxSnapshot;
  forms: SiteFormEvidence[];
  network_records?: NetworkRecord[];
}): SiteSkillEvidence {
  const parsed = new URL(input.url);
  return {
    schema_version: 1,
    evidence_id: input.evidence_id,
    captured_at: input.captured_at,
    site: {
      url: parsed.href,
      origin: parsed.origin,
      title: input.title
    },
    ax: {
      target_count: input.ax.elements.length,
      targets: input.ax.elements.slice(0, 100).map((element) => ({
        role: element.role,
        name: element.name,
        disabled: element.disabled
      }))
    },
    forms: input.forms.slice(0, 20).map((form) => ({
      ...form,
      fields: form.fields.slice(0, 100)
    })),
    network: summarizeSiteNetworkEvidence(
      input.network_records || []
    )
  };
}

export function compileSiteEvidenceToCandidate(
  evidence: SiteSkillEvidence,
  requestedName?: string
): SiteCandidateSkill {
  if (evidence.schema_version !== 1) {
    throw new Error("SITE_SKILL_REQUIRES_EVIDENCE_V1");
  }
  if (!evidence.site.url || !evidence.site.origin) {
    throw new Error("SITE_SKILL_REQUIRES_SITE_IDENTITY");
  }
  const apiRecipes = deriveApiRecipes(evidence);
  if (!evidence.forms.length && !apiRecipes.recipes.length) {
    throw new Error("SITE_SKILL_REQUIRES_ACTIONABLE_FORM_EVIDENCE");
  }

  const used = new Map<string, number>();
  const parameters: SiteSkillParameter[] = [];
  const parameterByField = new Map<string, string>();

  for (const form of evidence.forms) {
    for (const field of form.fields) {
      if (
        ["hidden", "submit", "button", "reset", "image"].includes(
          field.type
        )
      ) {
        continue;
      }
      const name = uniqueName(parameterBase(field), used);
      parameters.push({
        name,
        label:
          field.accessible_name || field.name || `Form ${form.index + 1} input`,
        type: fieldParameterType(field),
        required: field.required,
        sensitive:
          field.type === "password" || field.type === "file",
        source: {
          form_index: form.index,
          field_name: field.name || field.id || field.accessible_name
        },
        ...(field.options?.length
          ? { options: [...field.options] }
          : {})
      });
      parameterByField.set(
        `${form.index}:${field.name}:${field.id || ""}:${field.accessible_name}`,
        name
      );
    }
  }

  const formRecipes = evidence.forms.map((form) => {
    const inputSteps: SiteSkillRecipeStep[] = [];
    const parameterNames: string[] = [];
    const checks: SiteSkillRecipe["verification"]["checks"] = [
      {
        kind: "form_present",
        expect: {
          action: form.action,
          method: form.method
        }
      }
    ];

    for (const field of form.fields) {
      const parameter = parameterByField.get(
        `${form.index}:${field.name}:${field.id || ""}:${field.accessible_name}`
      );
      if (!parameter) continue;

      parameterNames.push(parameter);
      inputSteps.push({
        kind: "input",
        form_index: form.index,
        input_mode: fieldInputMode(field),
        parameter,
        target: targetForField(field)
      });
      checks.push({
        kind: "field_present",
        expect: {
          name: field.name,
          type: field.type,
          accessible_name: field.accessible_name
        }
      });
    }

    const submitTarget = form.submit
      ? {
          role: "button",
          accessible_name: form.submit.accessible_name,
          tag: "button",
          selector_hints: {
            ...(form.submit.id ? { id: form.submit.id } : {}),
            ...(form.submit.name ? { name: form.submit.name } : {})
          },
          resolution:
            "fresh_semantic_then_dom_hint" as const
        }
      : undefined;

    if (submitTarget) {
      checks.push({
        kind: "submit_target",
        expect: {
          accessible_name: submitTarget.accessible_name
        }
      });
    }

    const recipeName =
      form.name ||
      form.id ||
      form.submit?.accessible_name ||
      `Form ${form.index + 1}`;

    return {
      id: `recipe-form-${form.index + 1}`,
      name: recipeName,
      entry_url: evidence.site.url,
      form_index: form.index,
      method: form.method,
      action: form.action,
      parameters: parameterNames,
      steps: [
        ...inputSteps,
        {
          kind: "submit" as const,
          form_index: form.index,
          ...(submitTarget ? { target: submitTarget } : {}),
          method: form.method,
          action: form.action,
          approval: "browsercrew_runtime" as const
        }
      ],
      verification: {
        required: true as const,
        checks
      }
    };
  });

  const recipes = [...formRecipes, ...apiRecipes.recipes];
  for (const parameter of apiRecipes.parameters) {
    const unique = uniqueName(parameter.name, used);
    if (unique !== parameter.name) {
      for (const recipe of apiRecipes.recipes) {
        recipe.parameters = recipe.parameters.map((name) =>
          name === parameter.name ? unique : name
        );
        for (const step of recipe.steps) {
          if (step.kind === "api_fetch") {
            for (const query of step.query) {
              if (query.parameter === parameter.name) {
                query.parameter = unique;
              }
            }
          }
        }
      }
      parameter.name = unique;
    }
    parameters.push(parameter);
  }

  const baseName =
    requestedName?.trim() ||
    evidence.site.title.trim() ||
    new URL(evidence.site.url).hostname;

  return {
    schema_version: 1,
    id: `SK-SITE-${evidence.evidence_id
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)}`,
    slug: slug(baseName),
    name: baseName,
    version: "0.1.0",
    status: "candidate",
    lifecycle: {
      auto_promote: false,
      promotion_requires_evaluation: true
    },
    site: {
      origin: evidence.site.origin,
      entry_url: evidence.site.url,
      title: evidence.site.title
    },
    parameters,
    recipes,
    network_candidates: evidence.network,
    safety: {
      execution_requires_fresh_resolution: true,
      approval_policy: "preserve_browsercrew_approval_rules",
      structural_analysis_is_not_execution_proof: true
    },
    provenance: {
      source_kind: "site_analysis_v1",
      evidence_id: evidence.evidence_id,
      captured_at: evidence.captured_at,
      ax_target_count: evidence.ax.target_count,
      form_count: evidence.forms.length,
      network_request_count: evidence.network.length
    }
  };
}
