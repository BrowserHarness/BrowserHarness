import { embedTexts } from "./model-client";
import {
  listSiteSkillFamilies,
  type SiteSkillFamilyRecord
} from "./site-skill-store";
import type {
  SiteCandidateSkill,
  SiteSkillRecipeStep
} from "./site-skill";
import {
  loadEmbeddingConnection,
  type ProviderConnection
} from "../settings/provider-store";

const KEY = "browsercrew.proceduralVectors.v1";
const MAX_INDEX = 300;
const MAX_REINDEX_PER_SEARCH = 32;

export interface ProceduralRecipeContract {
  id: string;
  name: string;
  entry_url: string;
  method: string;
  action: string;
  parameters: string[];
  steps: Array<{
    kind: "input" | "submit";
    input_mode?: "type" | "select" | "upload" | "toggle";
    parameter?: string;
    role?: string;
    accessible_name?: string;
    method?: string;
    action?: string;
  }>;
}

export interface ProceduralMemoryRecord {
  skill_id: string;
  revision_id: string;
  active: boolean;
  latest: boolean;
  lifecycle: "active" | "candidate";
  name: string;
  slug: string;
  origin: string;
  entry_url: string;
  captured_at: string;
  structural_verification: "passed" | "failed" | "missing";
  latest_execution: "passed" | "failed" | "missing";
  execution_runs: number;
  execution_passed: number;
  execution_failed: number;
  execution_success_rate: number | null;
  promotion_eligible: boolean;
  promotion_reasons: string[];
  parameters: Array<{
    name: string;
    label: string;
    type: string;
    required: boolean;
    sensitive: boolean;
  }>;
  recipes: ProceduralRecipeContract[];
}

export interface ProceduralSearchHit {
  procedure: ProceduralMemoryRecord;
  score: number;
  lexical_rank?: number;
  semantic_rank?: number;
  semantic_similarity?: number;
  evidence_preference: number;
  retrieval: Array<"lexical" | "semantic">;
}

interface ProceduralVectorRecord {
  skill_id: string;
  revision_id: string;
  connection_id: string;
  model: string;
  dimensions: number;
  content_hash: string;
  indexed_at: string;
  vector: number[];
}

function latestOutcome(
  family: SiteSkillFamilyRecord,
  revisionId: string,
  kind: "structural-verification" | "execution"
): "passed" | "failed" | "missing" {
  return (
    [...family.evaluations]
      .reverse()
      .find(
        (item) =>
          item.revision_id === revisionId &&
          item.kind === kind
      )?.outcome || "missing"
  );
}

function recipeStep(
  step: SiteSkillRecipeStep
): ProceduralRecipeContract["steps"][number] {
  if (step.kind === "input") {
    return {
      kind: "input",
      input_mode: step.input_mode,
      parameter: step.parameter,
      ...(step.target.role ? { role: step.target.role } : {}),
      ...(step.target.accessible_name
        ? { accessible_name: step.target.accessible_name }
        : {})
    };
  }

  return {
    kind: "submit",
    method: step.method,
    action: step.action,
    ...(step.target?.role ? { role: step.target.role } : {}),
    ...(step.target?.accessible_name
      ? { accessible_name: step.target.accessible_name }
      : {})
  };
}

function promotionGate(
  family: SiteSkillFamilyRecord,
  revisionId: string
): {
  eligible: boolean;
  reasons: string[];
} {
  const structural = latestOutcome(
    family,
    revisionId,
    "structural-verification"
  );
  const execution = latestOutcome(
    family,
    revisionId,
    "execution"
  );
  const reasons: string[] = [];

  if (structural !== "passed") {
    reasons.push(
      structural === "missing"
        ? "structural verification evidence is missing"
        : "latest structural verification failed"
    );
  }
  if (execution !== "passed") {
    reasons.push(
      execution === "missing"
        ? "execution evidence is missing"
        : "latest execution failed"
    );
  }

  return {
    eligible: reasons.length === 0,
    reasons
  };
}

function recordForRevision(
  family: SiteSkillFamilyRecord,
  revisionId: string
): ProceduralMemoryRecord | null {
  const revision = family.revisions.find(
    (item) => item.revision_id === revisionId
  );
  if (!revision) return null;

  const candidate: SiteCandidateSkill = revision.candidate;
  const executions = (family.executions || []).filter(
    (item) => item.revision_id === revisionId
  );
  const passed = executions.filter(
    (item) => item.outcome === "passed"
  ).length;
  const failed = executions.filter(
    (item) => item.outcome === "failed"
  ).length;
  const gate = promotionGate(family, revisionId);

  return {
    skill_id: family.id,
    revision_id: revisionId,
    active: family.active_revision_id === revisionId,
    latest: family.latest_revision_id === revisionId,
    lifecycle:
      family.active_revision_id === revisionId
        ? "active"
        : "candidate",
    name: candidate.name,
    slug: candidate.slug,
    origin: candidate.site.origin,
    entry_url: candidate.site.entry_url,
    captured_at: candidate.provenance.captured_at,
    structural_verification: latestOutcome(
      family,
      revisionId,
      "structural-verification"
    ),
    latest_execution: latestOutcome(
      family,
      revisionId,
      "execution"
    ),
    execution_runs: executions.length,
    execution_passed: passed,
    execution_failed: failed,
    execution_success_rate:
      executions.length > 0
        ? passed / executions.length
        : null,
    promotion_eligible: gate.eligible,
    promotion_reasons: gate.reasons,
    parameters: candidate.parameters.map((parameter) => ({
      name: parameter.name,
      label: parameter.label,
      type: parameter.type,
      required: parameter.required,
      sensitive: parameter.sensitive
    })),
    recipes: candidate.recipes.map((recipe) => ({
      id: recipe.id,
      name: recipe.name,
      entry_url: recipe.entry_url,
      method: recipe.method,
      action: recipe.action,
      parameters: [...recipe.parameters],
      steps: recipe.steps.map(recipeStep)
    }))
  };
}

export async function listProceduralMemory(): Promise<
  ProceduralMemoryRecord[]
> {
  const families = await listSiteSkillFamilies();
  const records: ProceduralMemoryRecord[] = [];

  for (const family of families) {
    const revisionIds = [
      family.active_revision_id,
      family.latest_revision_id
    ].filter(
      (id, index, values): id is string =>
        Boolean(id) && values.indexOf(id) === index
    );

    for (const revisionId of revisionIds) {
      const record = recordForRevision(family, revisionId);
      if (record) records.push(record);
    }
  }

  return records;
}

export function proceduralEmbeddingText(
  procedure: ProceduralMemoryRecord
): string {
  return [
    `skill: ${procedure.name}`,
    `origin: ${procedure.origin}`,
    `entry: ${procedure.entry_url}`,
    `lifecycle: ${procedure.lifecycle}`,
    `verification: ${procedure.structural_verification}`,
    `execution: ${procedure.latest_execution}`,
    `parameters: ${procedure.parameters
      .map((item) => `${item.label} ${item.name} ${item.type}`)
      .join(" ")}`,
    `recipes: ${procedure.recipes
      .map((recipe) =>
        [
          recipe.name,
          recipe.method,
          recipe.action,
          ...recipe.steps.map((step) =>
            [
              step.kind,
              step.input_mode || "",
              step.parameter || "",
              step.role || "",
              step.accessible_name || ""
            ]
              .filter(Boolean)
              .join(" ")
          )
        ].join(" ")
      )
      .join(" ")}`
  ].join("\n");
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function cosine(
  left: number[],
  right: number[]
): number | null {
  if (!left.length || left.length !== right.length) return null;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (!leftNorm || !rightNorm) return null;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function tokens(value: string): string[] {
  return [...new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9._:/-]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
  )];
}

function lexicalScore(
  procedure: ProceduralMemoryRecord,
  query: string
): number {
  const queryText = query.toLowerCase().trim();
  const queryTokens = tokens(queryText);
  const haystack = proceduralEmbeddingText(
    procedure
  ).toLowerCase();

  let score = haystack.includes(queryText) ? 100 : 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) score += 10;
    if (procedure.name.toLowerCase().includes(token)) score += 5;
    if (procedure.origin.toLowerCase().includes(token)) score += 5;
  }
  return score;
}

function evidencePreference(
  procedure: ProceduralMemoryRecord
): number {
  let score = 0;
  if (procedure.active) score += 0.003;
  if (procedure.structural_verification === "passed") {
    score += 0.001;
  }
  if (procedure.latest_execution === "passed") {
    score += 0.002;
  }
  return score;
}

function rrf(rank: number): number {
  return 1 / (60 + rank);
}

async function loadIndex(): Promise<ProceduralVectorRecord[]> {
  const stored = await chrome.storage.local.get(KEY);
  return Array.isArray(stored[KEY])
    ? (stored[KEY] as ProceduralVectorRecord[])
    : [];
}

async function saveIndex(
  records: ProceduralVectorRecord[]
): Promise<void> {
  await chrome.storage.local.set({
    [KEY]: records.slice(0, MAX_INDEX)
  });
}

function vectorRecord(
  records: ProceduralVectorRecord[],
  procedure: ProceduralMemoryRecord,
  connection: ProviderConnection
): ProceduralVectorRecord | null {
  const hash = stableHash(
    proceduralEmbeddingText(procedure)
  );
  return (
    records.find(
      (record) =>
        record.skill_id === procedure.skill_id &&
        record.revision_id === procedure.revision_id &&
        record.connection_id === connection.id &&
        record.model === connection.model &&
        record.content_hash === hash
    ) || null
  );
}

async function ensureVectors(
  connection: ProviderConnection,
  procedures: ProceduralMemoryRecord[],
  existing: ProceduralVectorRecord[]
): Promise<ProceduralVectorRecord[]> {
  const missing = procedures
    .filter(
      (procedure) =>
        !vectorRecord(existing, procedure, connection)
    )
    .slice(0, MAX_REINDEX_PER_SEARCH);

  if (!missing.length) return existing;

  const texts = missing.map(proceduralEmbeddingText);
  const embedded = await embedTexts(connection, texts);
  const indexedAt = new Date().toISOString();

  const replacements = missing.map(
    (procedure, index): ProceduralVectorRecord => ({
      skill_id: procedure.skill_id,
      revision_id: procedure.revision_id,
      connection_id: connection.id,
      model: connection.model,
      dimensions: embedded.dimensions,
      content_hash: stableHash(texts[index]),
      indexed_at: indexedAt,
      vector: embedded.vectors[index]
    })
  );

  const ids = new Set(
    replacements.map(
      (record) =>
        `${record.skill_id}\u0000${record.revision_id}\u0000${record.connection_id}`
    )
  );

  const next = [
    ...replacements,
    ...existing.filter(
      (record) =>
        !ids.has(
          `${record.skill_id}\u0000${record.revision_id}\u0000${record.connection_id}`
        )
    )
  ].slice(0, MAX_INDEX);

  await saveIndex(next);
  return next;
}

function lexicalHits(
  procedures: ProceduralMemoryRecord[],
  query: string
): ProceduralSearchHit[] {
  return procedures
    .map((procedure) => ({
      procedure,
      lexical: lexicalScore(procedure, query)
    }))
    .filter((item) => item.lexical > 0)
    .sort(
      (left, right) =>
        right.lexical - left.lexical ||
        evidencePreference(right.procedure) -
          evidencePreference(left.procedure)
    )
    .map((item, index) => ({
      procedure: item.procedure,
      score:
        rrf(index + 1) +
        evidencePreference(item.procedure),
      lexical_rank: index + 1,
      evidence_preference:
        evidencePreference(item.procedure),
      retrieval: ["lexical"] as Array<"lexical" | "semantic">
    }));
}

export async function searchProceduralMemory(
  query: string,
  limit = 8
): Promise<ProceduralSearchHit[]> {
  const boundedLimit = Math.min(
    Math.max(Math.round(Number(limit) || 8), 1),
    20
  );
  const procedures = await listProceduralMemory();
  const lexical = lexicalHits(procedures, query);
  const connection = await loadEmbeddingConnection();

  if (!connection) {
    return lexical.slice(0, boundedLimit);
  }

  try {
    let index = await loadIndex();
    index = await ensureVectors(
      connection,
      procedures,
      index
    );
    const queryEmbedding = await embedTexts(
      connection,
      [query.slice(0, 1000)]
    );
    const queryVector = queryEmbedding.vectors[0];

    const semantic = procedures
      .map((procedure) => {
        const record = vectorRecord(
          index,
          procedure,
          connection
        );
        if (
          !record ||
          record.dimensions !== queryEmbedding.dimensions
        ) {
          return null;
        }
        const similarity = cosine(
          queryVector,
          record.vector
        );
        return similarity === null
          ? null
          : { procedure, similarity };
      })
      .filter(
        (
          item
        ): item is {
          procedure: ProceduralMemoryRecord;
          similarity: number;
        } => Boolean(item)
      )
      .sort(
        (left, right) =>
          right.similarity - left.similarity ||
          evidencePreference(right.procedure) -
            evidencePreference(left.procedure)
      );

    const combined = new Map<
      string,
      ProceduralSearchHit
    >();

    lexical.forEach((hit) => {
      combined.set(
        `${hit.procedure.skill_id}\u0000${hit.procedure.revision_id}`,
        {
          ...hit,
          retrieval: [...hit.retrieval]
        }
      );
    });

    semantic.forEach((item, index) => {
      const key =
        `${item.procedure.skill_id}\u0000${item.procedure.revision_id}`;
      const current = combined.get(key);
      if (current) {
        current.score += rrf(index + 1);
        current.semantic_rank = index + 1;
        current.semantic_similarity = item.similarity;
        if (!current.retrieval.includes("semantic")) {
          current.retrieval.push("semantic");
        }
      } else {
        const preference = evidencePreference(
          item.procedure
        );
        combined.set(key, {
          procedure: item.procedure,
          score: rrf(index + 1) + preference,
          semantic_rank: index + 1,
          semantic_similarity: item.similarity,
          evidence_preference: preference,
          retrieval: ["semantic"]
        });
      }
    });

    return [...combined.values()]
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.evidence_preference -
            left.evidence_preference
      )
      .slice(0, boundedLimit);
  } catch {
    return lexical.slice(0, boundedLimit);
  }
}

export const PROCEDURAL_VECTOR_KEY = KEY;
