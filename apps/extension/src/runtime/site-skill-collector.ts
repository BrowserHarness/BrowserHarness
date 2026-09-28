import {
  captureAxSnapshot
} from "../background/cdp-semantic";
import {
  listNetworkRecords,
  networkCaptureActive
} from "../background/network-capture";
import {
  evaluatePageExpression
} from "../background/page-evaluate";
import {
  compileSiteEvidenceToCandidate,
  createSiteSkillEvidence,
  type SiteCandidateSkill,
  type SiteFormEvidence,
  type SiteSkillEvidence
} from "./site-skill";

export const SITE_FORM_INSPECTION_EXPRESSION = `(() => {
  const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const labelFor = (element) => {
    const labels = element.labels ? Array.from(element.labels) : [];
    const labelled = labels.map((label) => clean(label.innerText || label.textContent)).find(Boolean);
    return labelled ||
      clean(element.getAttribute && element.getAttribute("aria-label")) ||
      clean(element.getAttribute && element.getAttribute("placeholder")) ||
      clean(element.name) ||
      clean(element.id);
  };

  return Array.from(document.forms).slice(0, 20).map((form, index) => {
    const fields = Array.from(form.elements)
      .slice(0, 100)
      .map((element) => {
        const tag = clean(element.tagName).toLowerCase();
        const type = clean(element.type || (tag === "select" ? "select-one" : tag)).toLowerCase();
        const name = clean(element.name);
        const id = clean(element.id);
        const accessible_name = labelFor(element);
        const required = Boolean(element.required || (element.getAttribute && element.getAttribute("aria-required") === "true"));
        const rawMaxLength = Number(element.maxLength);
        const autocomplete = clean(element.autocomplete);
        const placeholder = clean(element.placeholder);
        const options =
          tag === "select" && element.options
            ? Array.from(element.options)
                .slice(0, 100)
                .map((option) => clean(option.value || option.textContent))
                .filter(Boolean)
            : undefined;

        if (!tag || !["input", "textarea", "select"].includes(tag)) {
          return null;
        }

        return {
          tag,
          type,
          name,
          ...(id ? { id } : {}),
          accessible_name,
          required,
          ...(Number.isFinite(rawMaxLength) && rawMaxLength > 0 ? { max_length: rawMaxLength } : {}),
          ...(autocomplete ? { autocomplete } : {}),
          ...(placeholder ? { placeholder } : {}),
          ...(options && options.length ? { options } : {})
        };
      })
      .filter(Boolean);

    const submit = form.querySelector(
      'button[type="submit"], input[type="submit"], button:not([type])'
    );
    const submitName = submit ? clean(submit.name) : "";
    const submitId = submit ? clean(submit.id) : "";
    const submitLabel = submit
      ? labelFor(submit) || clean(submit.innerText || submit.value || submit.textContent)
      : "";

    return {
      index,
      ...(clean(form.id) ? { id: clean(form.id) } : {}),
      ...(clean(form.name) ? { name: clean(form.name) } : {}),
      action: form.action || location.href,
      method: clean(form.method || "get").toUpperCase(),
      fields,
      ...(submit
        ? {
            submit: {
              accessible_name: submitLabel || "Submit",
              ...(submitId ? { id: submitId } : {}),
              ...(submitName ? { name: submitName } : {})
            }
          }
        : {})
    };
  });
})()`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeForms(value: unknown): SiteFormEvidence[] {
  if (!Array.isArray(value)) return [];

  const forms: SiteFormEvidence[] = [];
  for (const [fallbackIndex, raw] of value.entries()) {
    if (!isRecord(raw)) continue;

    const fields: SiteFormEvidence["fields"] = [];
    if (Array.isArray(raw.fields)) {
      for (const rawField of raw.fields) {
        if (!isRecord(rawField)) continue;
        const tag = typeof rawField.tag === "string" ? rawField.tag : "";
        const type = typeof rawField.type === "string" ? rawField.type : "";
        if (!tag || !type) continue;

        fields.push({
          tag,
          type,
          name: typeof rawField.name === "string" ? rawField.name : "",
          ...(typeof rawField.id === "string" && rawField.id
            ? { id: rawField.id }
            : {}),
          accessible_name:
            typeof rawField.accessible_name === "string"
              ? rawField.accessible_name
              : "",
          required: rawField.required === true,
          ...(typeof rawField.max_length === "number"
            ? { max_length: rawField.max_length }
            : {}),
          ...(typeof rawField.autocomplete === "string"
            ? { autocomplete: rawField.autocomplete }
            : {}),
          ...(typeof rawField.placeholder === "string"
            ? { placeholder: rawField.placeholder }
            : {}),
          ...(Array.isArray(rawField.options) &&
          rawField.options.every((item) => typeof item === "string")
            ? { options: rawField.options as string[] }
            : {})
        });
      }
    }

    const submit = isRecord(raw.submit)
      ? {
          accessible_name:
            typeof raw.submit.accessible_name === "string"
              ? raw.submit.accessible_name
              : "Submit",
          ...(typeof raw.submit.id === "string" && raw.submit.id
            ? { id: raw.submit.id }
            : {}),
          ...(typeof raw.submit.name === "string" && raw.submit.name
            ? { name: raw.submit.name }
            : {})
        }
      : undefined;

    forms.push({
      index:
        typeof raw.index === "number" ? raw.index : fallbackIndex,
      ...(typeof raw.id === "string" && raw.id
        ? { id: raw.id }
        : {}),
      ...(typeof raw.name === "string" && raw.name
        ? { name: raw.name }
        : {}),
      action:
        typeof raw.action === "string" ? raw.action : "",
      method:
        typeof raw.method === "string"
          ? raw.method.toUpperCase()
          : "GET",
      fields,
      ...(submit ? { submit } : {})
    });
  }

  return forms;
}

export async function collectCurrentSiteSkill(input: {
  tab_id: number;
  url: string;
  title: string;
  requested_name?: string;
  include_network?: boolean;
  evidence_id?: string;
  captured_at?: string;
}): Promise<{
  evidence: SiteSkillEvidence;
  candidate: SiteCandidateSkill;
}> {
  const ax = await captureAxSnapshot(input.tab_id, 1000);
  const inspected = await evaluatePageExpression(
    input.tab_id,
    SITE_FORM_INSPECTION_EXPRESSION,
    80_000
  );
  const forms = normalizeForms(inspected.value);
  const networkRecords =
    input.include_network !== false &&
    networkCaptureActive(input.tab_id)
      ? listNetworkRecords(input.tab_id, 100)
      : [];

  const evidence = createSiteSkillEvidence({
    evidence_id: input.evidence_id || crypto.randomUUID(),
    captured_at: input.captured_at || new Date().toISOString(),
    url: input.url,
    title: input.title,
    ax,
    forms,
    network_records: networkRecords
  });

  return {
    evidence,
    candidate: compileSiteEvidenceToCandidate(
      evidence,
      input.requested_name
    )
  };
}
