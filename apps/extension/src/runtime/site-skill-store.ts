import type { SiteCandidateSkill } from "./site-skill";

const LEGACY_KEY = "browsercrew.siteSkillCandidates.v1";
const KEY = "browsercrew.siteSkillLibrary.v2";
const MAX_FAMILIES = 100;
const MAX_REVISIONS_PER_FAMILY = 50;

export type SiteSkillRevisionReason =
  | "create"
  | "verify"
  | "run-verification"
  | "refinement"
  | "migration"
  | "snapshot";

export interface SiteSkillRevisionRecord {
  revision_id: string;
  ordinal: number;
  created_at: string;
  reason: SiteSkillRevisionReason;
  parent_revision_id?: string;
  candidate: SiteCandidateSkill;
}

export type SiteSkillEvaluationKind =
  | "structural-verification"
  | "execution";
export type SiteSkillEvaluationOutcome = "passed" | "failed";

export interface SiteSkillEvaluationRecord {
  evaluation_id: string;
  revision_id: string;
  recorded_at: string;
  kind: SiteSkillEvaluationKind;
  outcome: SiteSkillEvaluationOutcome;
  detail?: string;
}

export interface SiteSkillExecutionEvidenceRecord {
  execution_id: string;
  revision_id: string;
  recipe_id: string;
  started_at: string;
  finished_at: string;
  outcome: SiteSkillEvaluationOutcome;
  evidence_id?: string;
  executed_steps: number;
  submitted: boolean;
  parameter_names: string[];
  error_code?: string;
  error_message?: string;
}

export interface SiteSkillLifecycleEvent {
  event_id: string;
  recorded_at: string;
  kind: "promotion" | "rollback";
  from_revision_id?: string;
  to_revision_id: string;
}

export interface SiteSkillPromotionGate {
  revision_id: string;
  eligible: boolean;
  structural_verification: SiteSkillEvaluationOutcome | "missing";
  execution: SiteSkillEvaluationOutcome | "missing";
  reasons: string[];
}

export interface SiteSkillRevisionPerformance {
  revision_id: string;
  active: boolean;
  structural_verification:
    | SiteSkillEvaluationOutcome
    | "missing";
  latest_execution:
    | SiteSkillEvaluationOutcome
    | "missing";
  execution_runs: number;
  execution_passed: number;
  execution_failed: number;
  execution_success_rate: number | null;
  last_failure?: {
    finished_at: string;
    error_code?: string;
    error_message?: string;
  };
}

export interface SiteSkillRevisionComparison {
  candidate: SiteSkillRevisionPerformance;
  baseline: SiteSkillRevisionPerformance | null;
  regression_signals: string[];
  improvement_signals: string[];
}

export interface SiteSkillFamilyRecord {
  id: string;
  slug: string;
  name: string;
  latest_revision_id: string;
  active_revision_id?: string;
  revisions: SiteSkillRevisionRecord[];
  evaluations: SiteSkillEvaluationRecord[];
  executions?: SiteSkillExecutionEvidenceRecord[];
  lifecycle_events: SiteSkillLifecycleEvent[];
}

export interface SiteSkillLibrary {
  schema_version: 2;
  families: SiteSkillFamilyRecord[];
}

export interface SaveSiteSkillCandidateOptions {
  reason?: SiteSkillRevisionReason;
  created_at?: string;
}

export interface SiteSkillRevisionSummary {
  revision_id: string;
  ordinal: number;
  active: boolean;
  created_at: string;
  reason: SiteSkillRevisionReason;
  parent_revision_id?: string;
  name: string;
  status: "candidate";
  verification_status?: "verified" | "failed";
}

export interface SiteSkillCandidateSummary {
  id: string;
  name: string;
  slug: string;
  status: "candidate";
  origin: string;
  entry_url: string;
  recipe_count: number;
  parameter_count: number;
  captured_at: string;
  verification_status?: "verified" | "failed";
  lifecycle_status: "candidate" | "active";
  revision_count: number;
  latest_revision_id: string;
  active_revision_id?: string;
}

function cloneCandidate(
  candidate: SiteCandidateSkill
): SiteCandidateSkill {
  return structuredClone(candidate);
}

function revisionTimestamp(
  candidate: SiteCandidateSkill,
  options: SaveSiteSkillCandidateOptions
): string {
  return (
    options.created_at ||
    candidate.verification?.verified_at ||
    candidate.provenance.captured_at ||
    new Date().toISOString()
  );
}

function revisionId(id: string, ordinal: number): string {
  return `${id}:r${ordinal}`;
}

function latestRevision(
  family: SiteSkillFamilyRecord
): SiteSkillRevisionRecord | null {
  return (
    family.revisions.find(
      (revision) =>
        revision.revision_id === family.latest_revision_id
    ) ||
    family.revisions.at(-1) ||
    null
  );
}

function sameCandidate(
  left: SiteCandidateSkill,
  right: SiteCandidateSkill
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function familyFromLegacyCandidate(
  candidate: SiteCandidateSkill
): SiteSkillFamilyRecord {
  const revision: SiteSkillRevisionRecord = {
    revision_id: revisionId(candidate.id, 1),
    ordinal: 1,
    created_at: candidate.provenance.captured_at,
    reason: "migration",
    candidate: cloneCandidate(candidate)
  };

  return {
    id: candidate.id,
    slug: candidate.slug,
    name: candidate.name,
    latest_revision_id: revision.revision_id,
    revisions: [revision],
    evaluations: candidate.verification
      ? [
          {
            evaluation_id: `${candidate.id}:eval-1`,
            revision_id: revision.revision_id,
            recorded_at:
              candidate.verification.verified_at,
            kind: "structural-verification",
            outcome:
              candidate.verification.status === "verified"
                ? "passed"
                : "failed",
            detail:
              "Migrated from legacy candidate verification"
          }
        ]
      : [],
    executions: [],
    lifecycle_events: []
  };
}

function normalizeFamily(
  family: SiteSkillFamilyRecord
): SiteSkillFamilyRecord {
  const revisions = Array.isArray(family.revisions)
    ? structuredClone(family.revisions)
    : [];
  const evaluations = Array.isArray(family.evaluations)
    ? structuredClone(family.evaluations)
    : [];

  for (const revision of revisions) {
    if (
      revision.candidate.verification &&
      !evaluations.some(
        (evaluation) =>
          evaluation.revision_id === revision.revision_id &&
          evaluation.kind === "structural-verification"
      )
    ) {
      evaluations.push({
        evaluation_id:
          `${family.id}:eval-${evaluations.length + 1}`,
        revision_id: revision.revision_id,
        recorded_at:
          revision.candidate.verification.verified_at,
        kind: "structural-verification",
        outcome:
          revision.candidate.verification.status === "verified"
            ? "passed"
            : "failed",
        detail:
          "Migrated from pre-ledger revision verification"
      });
    }
  }

  return {
    ...structuredClone(family),
    revisions,
    evaluations,
    executions: Array.isArray(family.executions)
      ? structuredClone(family.executions)
      : [],
    lifecycle_events: Array.isArray(family.lifecycle_events)
      ? structuredClone(family.lifecycle_events)
      : []
  };
}

function validLibrary(value: unknown): value is SiteSkillLibrary {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }

  const library = value as Partial<SiteSkillLibrary>;
  return (
    library.schema_version === 2 &&
    Array.isArray(library.families)
  );
}

async function loadStoredLibrary(): Promise<SiteSkillLibrary> {
  const current = await chrome.storage.local.get(KEY);
  if (validLibrary(current[KEY])) {
    return {
      schema_version: 2,
      families: current[KEY].families.map(normalizeFamily)
    };
  }

  const legacy = await chrome.storage.local.get(LEGACY_KEY);
  const candidates = Array.isArray(legacy[LEGACY_KEY])
    ? (legacy[LEGACY_KEY] as SiteCandidateSkill[])
    : [];

  return {
    schema_version: 2,
    families: candidates
      .slice(0, MAX_FAMILIES)
      .map(familyFromLegacyCandidate)
  };
}

async function persistLibrary(
  library: SiteSkillLibrary
): Promise<void> {
  await chrome.storage.local.set({
    [KEY]: structuredClone(library)
  });
}

export async function loadSiteSkillLibrary(): Promise<SiteSkillLibrary> {
  return loadStoredLibrary();
}

export async function loadSiteSkillCandidates(): Promise<
  SiteCandidateSkill[]
> {
  const library = await loadStoredLibrary();
  return library.families
    .map((family) => latestRevision(family)?.candidate)
    .filter(
      (candidate): candidate is SiteCandidateSkill =>
        Boolean(candidate)
    )
    .map(cloneCandidate);
}

export async function saveSiteSkillCandidate(
  candidate: SiteCandidateSkill,
  options: SaveSiteSkillCandidateOptions = {}
): Promise<SiteSkillRevisionRecord> {
  const library = await loadStoredLibrary();
  let family = library.families.find(
    (item) => item.id === candidate.id
  );

  if (!family) {
    family = {
      id: candidate.id,
      slug: candidate.slug,
      name: candidate.name,
      latest_revision_id: "",
      revisions: [],
      evaluations: [],
      executions: [],
      lifecycle_events: []
    };
    library.families.unshift(family);
  }

  const latest = latestRevision(family);
  if (latest && sameCandidate(latest.candidate, candidate)) {
    return structuredClone(latest);
  }

  const nextOrdinal =
    family.revisions.reduce(
      (max, revision) => Math.max(max, revision.ordinal),
      0
    ) + 1;
  const revision: SiteSkillRevisionRecord = {
    revision_id: revisionId(candidate.id, nextOrdinal),
    ordinal: nextOrdinal,
    created_at: revisionTimestamp(candidate, options),
    reason: options.reason || "snapshot",
    ...(latest
      ? { parent_revision_id: latest.revision_id }
      : {}),
    candidate: cloneCandidate(candidate)
  };

  family.slug = candidate.slug;
  family.name = candidate.name;
  family.latest_revision_id = revision.revision_id;
  family.revisions = [
    ...family.revisions,
    revision
  ].slice(-MAX_REVISIONS_PER_FAMILY);

  library.families = [
    family,
    ...library.families.filter(
      (item) => item.id !== family!.id
    )
  ].slice(0, MAX_FAMILIES);

  await persistLibrary(library);
  return structuredClone(revision);
}

export async function getSiteSkillRevision(
  id: string,
  revisionIdInput?: string
): Promise<SiteSkillRevisionRecord | null> {
  const library = await loadStoredLibrary();
  const family = library.families.find(
    (candidate) => candidate.id === id
  );
  if (!family) return null;

  const revision = revisionIdInput
    ? family.revisions.find(
        (item) => item.revision_id === revisionIdInput
      ) || null
    : latestRevision(family);

  return revision ? structuredClone(revision) : null;
}

export async function getSiteSkillCandidate(
  id: string,
  revisionIdInput?: string
): Promise<SiteCandidateSkill | null> {
  const revision = await getSiteSkillRevision(
    id,
    revisionIdInput
  );
  return revision
    ? cloneCandidate(revision.candidate)
    : null;
}

export async function getSiteSkillFamily(
  id: string
): Promise<SiteSkillFamilyRecord | null> {
  const library = await loadStoredLibrary();
  const family =
    library.families.find((candidate) => candidate.id === id) ||
    null;
  return family ? structuredClone(family) : null;
}

export async function getSiteSkillExecutableRevision(
  id: string,
  revisionIdInput?: string
): Promise<SiteSkillRevisionRecord | null> {
  const family = await getSiteSkillFamily(id);
  if (!family) return null;

  const revisionIdToUse =
    revisionIdInput ||
    family.active_revision_id ||
    family.latest_revision_id;

  const revision =
    family.revisions.find(
      (item) => item.revision_id === revisionIdToUse
    ) || null;

  return revision ? structuredClone(revision) : null;
}

export async function getSiteSkillExecutableCandidate(
  id: string,
  revisionIdInput?: string
): Promise<SiteCandidateSkill | null> {
  const revision = await getSiteSkillExecutableRevision(
    id,
    revisionIdInput
  );
  return revision
    ? cloneCandidate(revision.candidate)
    : null;
}

export async function listSiteSkillRevisions(
  id: string
): Promise<SiteSkillRevisionRecord[]> {
  const family = await getSiteSkillFamily(id);
  return family
    ? family.revisions.map((revision) =>
        structuredClone(revision)
      )
    : [];
}

export async function listSiteSkillRevisionSummaries(
  id: string
): Promise<SiteSkillRevisionSummary[]> {
  const family = await getSiteSkillFamily(id);
  if (!family) return [];

  return family.revisions.map((revision) => {
    const verification = latestEvaluation(
      family,
      revision.revision_id,
      "structural-verification"
    );
    return {
      revision_id: revision.revision_id,
      ordinal: revision.ordinal,
      active:
        family.active_revision_id === revision.revision_id,
      created_at: revision.created_at,
      reason: revision.reason,
      ...(revision.parent_revision_id
        ? {
            parent_revision_id:
              revision.parent_revision_id
          }
        : {}),
      name: revision.candidate.name,
      status: revision.candidate.status,
      ...(verification
        ? { verification_status: verification.outcome === "passed" ? "verified" : "failed" }
        : {})
    };
  });
}

function nextEvaluationId(
  family: SiteSkillFamilyRecord
): string {
  return `${family.id}:eval-${family.evaluations.length + 1}`;
}

function nextExecutionId(
  family: SiteSkillFamilyRecord
): string {
  return `${family.id}:execution-${(family.executions?.length || 0) + 1}`;
}

function nextLifecycleEventId(
  family: SiteSkillFamilyRecord
): string {
  return `${family.id}:lifecycle-${family.lifecycle_events.length + 1}`;
}

function latestEvaluation(
  family: SiteSkillFamilyRecord,
  revisionIdInput: string,
  kind: SiteSkillEvaluationKind
): SiteSkillEvaluationRecord | null {
  return (
    [...family.evaluations]
      .reverse()
      .find(
        (evaluation) =>
          evaluation.revision_id === revisionIdInput &&
          evaluation.kind === kind
      ) || null
  );
}

function revisionPerformance(
  family: SiteSkillFamilyRecord,
  revisionIdInput: string
): SiteSkillRevisionPerformance {
  if (
    !family.revisions.some(
      (revision) =>
        revision.revision_id === revisionIdInput
    )
  ) {
    throw new Error("SITE_SKILL_REVISION_NOT_FOUND");
  }

  const structural = latestEvaluation(
    family,
    revisionIdInput,
    "structural-verification"
  );
  const execution = latestEvaluation(
    family,
    revisionIdInput,
    "execution"
  );
  const executions = (family.executions || []).filter(
    (item) => item.revision_id === revisionIdInput
  );
  const executionPassed = executions.filter(
    (item) => item.outcome === "passed"
  ).length;
  const executionFailed = executions.filter(
    (item) => item.outcome === "failed"
  ).length;
  const total = executions.length;
  const lastFailure = [...executions]
    .reverse()
    .find((item) => item.outcome === "failed");

  return {
    revision_id: revisionIdInput,
    active: family.active_revision_id === revisionIdInput,
    structural_verification:
      structural?.outcome || "missing",
    latest_execution: execution?.outcome || "missing",
    execution_runs: total,
    execution_passed: executionPassed,
    execution_failed: executionFailed,
    execution_success_rate:
      total > 0 ? executionPassed / total : null,
    ...(lastFailure
      ? {
          last_failure: {
            finished_at: lastFailure.finished_at,
            ...(lastFailure.error_code
              ? { error_code: lastFailure.error_code }
              : {}),
            ...(lastFailure.error_message
              ? { error_message: lastFailure.error_message }
              : {})
          }
        }
      : {})
  };
}

export function compareSiteSkillRevisions(
  family: SiteSkillFamilyRecord,
  candidateRevisionId: string,
  baselineRevisionId?: string
): SiteSkillRevisionComparison {
  const candidate = revisionPerformance(
    family,
    candidateRevisionId
  );
  const baseline =
    baselineRevisionId &&
    baselineRevisionId !== candidateRevisionId
      ? revisionPerformance(family, baselineRevisionId)
      : null;

  const regressionSignals: string[] = [];
  const improvementSignals: string[] = [];

  if (candidate.structural_verification === "failed") {
    regressionSignals.push(
      "candidate structural verification is failing"
    );
  }
  if (candidate.latest_execution === "failed") {
    regressionSignals.push(
      "candidate latest execution is failing"
    );
  }
  if (candidate.execution_runs === 0) {
    regressionSignals.push(
      "candidate has no execution evidence"
    );
  }

  if (baseline) {
    if (
      candidate.execution_success_rate !== null &&
      baseline.execution_success_rate !== null
    ) {
      if (
        candidate.execution_success_rate <
        baseline.execution_success_rate
      ) {
        regressionSignals.push(
          "candidate execution success rate is below baseline"
        );
      } else if (
        candidate.execution_success_rate >
        baseline.execution_success_rate
      ) {
        improvementSignals.push(
          "candidate execution success rate is above baseline"
        );
      }
    }

    if (
      candidate.latest_execution === "passed" &&
      baseline.latest_execution === "failed"
    ) {
      improvementSignals.push(
        "candidate latest execution passes while baseline latest execution fails"
      );
    }
    if (
      candidate.latest_execution === "failed" &&
      baseline.latest_execution === "passed"
    ) {
      regressionSignals.push(
        "candidate latest execution fails while baseline latest execution passes"
      );
    }
  }

  return {
    candidate,
    baseline,
    regression_signals: [...new Set(regressionSignals)],
    improvement_signals: [...new Set(improvementSignals)]
  };
}

export async function getSiteSkillRevisionComparison(
  id: string,
  candidateRevisionId?: string,
  baselineRevisionId?: string
): Promise<SiteSkillRevisionComparison | null> {
  const family = await getSiteSkillFamily(id);
  if (!family) return null;

  const candidateId =
    candidateRevisionId || family.latest_revision_id;
  const baselineId =
    baselineRevisionId ||
    (family.active_revision_id !== candidateId
      ? family.active_revision_id
      : undefined);

  return compareSiteSkillRevisions(
    family,
    candidateId,
    baselineId
  );
}

export function siteSkillPromotionGate(
  family: SiteSkillFamilyRecord,
  revisionIdInput: string
): SiteSkillPromotionGate {
  const structural = latestEvaluation(
    family,
    revisionIdInput,
    "structural-verification"
  );
  const execution = latestEvaluation(
    family,
    revisionIdInput,
    "execution"
  );
  const reasons: string[] = [];

  if (structural?.outcome !== "passed") {
    reasons.push(
      structural
        ? "latest structural verification failed"
        : "structural verification evidence is missing"
    );
  }
  if (execution?.outcome !== "passed") {
    reasons.push(
      execution
        ? "latest execution evaluation failed"
        : "successful execution evidence is missing"
    );
  }

  return {
    revision_id: revisionIdInput,
    eligible: reasons.length === 0,
    structural_verification:
      structural?.outcome || "missing",
    execution: execution?.outcome || "missing",
    reasons
  };
}

export async function recordSiteSkillEvaluation(
  id: string,
  revisionIdInput: string,
  input: {
    kind: SiteSkillEvaluationKind;
    outcome: SiteSkillEvaluationOutcome;
    recorded_at?: string;
    detail?: string;
  }
): Promise<SiteSkillEvaluationRecord> {
  const library = await loadStoredLibrary();
  const family = library.families.find(
    (item) => item.id === id
  );
  if (!family) {
    throw new Error("SITE_SKILL_NOT_FOUND");
  }
  if (
    !family.revisions.some(
      (revision) =>
        revision.revision_id === revisionIdInput
    )
  ) {
    throw new Error("SITE_SKILL_REVISION_NOT_FOUND");
  }

  const evaluation: SiteSkillEvaluationRecord = {
    evaluation_id: nextEvaluationId(family),
    revision_id: revisionIdInput,
    recorded_at: input.recorded_at || new Date().toISOString(),
    kind: input.kind,
    outcome: input.outcome,
    ...(input.detail ? { detail: input.detail } : {})
  };
  family.evaluations.push(evaluation);
  await persistLibrary(library);
  return structuredClone(evaluation);
}

export async function recordSiteSkillExecutionEvidence(
  id: string,
  revisionIdInput: string,
  input: {
    recipe_id: string;
    started_at: string;
    finished_at?: string;
    outcome: SiteSkillEvaluationOutcome;
    evidence_id?: string;
    executed_steps?: number;
    submitted?: boolean;
    parameter_names?: string[];
    error_code?: string;
    error_message?: string;
  }
): Promise<SiteSkillExecutionEvidenceRecord> {
  const library = await loadStoredLibrary();
  const family = library.families.find(
    (item) => item.id === id
  );
  if (!family) {
    throw new Error("SITE_SKILL_NOT_FOUND");
  }
  if (
    !family.revisions.some(
      (revision) =>
        revision.revision_id === revisionIdInput
    )
  ) {
    throw new Error("SITE_SKILL_REVISION_NOT_FOUND");
  }

  const execution: SiteSkillExecutionEvidenceRecord = {
    execution_id: nextExecutionId(family),
    revision_id: revisionIdInput,
    recipe_id: input.recipe_id,
    started_at: input.started_at,
    finished_at: input.finished_at || new Date().toISOString(),
    outcome: input.outcome,
    ...(input.evidence_id
      ? { evidence_id: input.evidence_id }
      : {}),
    executed_steps: Math.max(
      0,
      Math.round(Number(input.executed_steps || 0))
    ),
    submitted: input.submitted === true,
    parameter_names: [...new Set(input.parameter_names || [])].sort(),
    ...(input.error_code
      ? { error_code: input.error_code }
      : {}),
    ...(input.error_message
      ? { error_message: input.error_message.slice(0, 1000) }
      : {})
  };

  family.executions = [
    ...(family.executions || []),
    execution
  ].slice(-500);
  await persistLibrary(library);
  return structuredClone(execution);
}

export async function listSiteSkillExecutionEvidence(
  id: string,
  revisionIdInput?: string
): Promise<SiteSkillExecutionEvidenceRecord[]> {
  const family = await getSiteSkillFamily(id);
  if (!family) return [];

  return (family.executions || [])
    .filter(
      (execution) =>
        !revisionIdInput ||
        execution.revision_id === revisionIdInput
    )
    .map((execution) => structuredClone(execution));
}

export async function getSiteSkillPromotionGate(
  id: string,
  revisionIdInput?: string
): Promise<SiteSkillPromotionGate | null> {
  const family = await getSiteSkillFamily(id);
  if (!family) return null;
  const revisionIdToUse =
    revisionIdInput || family.latest_revision_id;
  if (
    !family.revisions.some(
      (revision) =>
        revision.revision_id === revisionIdToUse
    )
  ) {
    return null;
  }
  return siteSkillPromotionGate(family, revisionIdToUse);
}

export async function promoteSiteSkillRevision(
  id: string,
  revisionIdInput: string,
  recordedAt?: string
): Promise<SiteSkillLifecycleEvent> {
  const library = await loadStoredLibrary();
  const family = library.families.find(
    (item) => item.id === id
  );
  if (!family) {
    throw new Error("SITE_SKILL_NOT_FOUND");
  }
  if (
    !family.revisions.some(
      (revision) =>
        revision.revision_id === revisionIdInput
    )
  ) {
    throw new Error("SITE_SKILL_REVISION_NOT_FOUND");
  }

  const gate = siteSkillPromotionGate(
    family,
    revisionIdInput
  );
  if (!gate.eligible) {
    throw new Error(
      `SITE_SKILL_PROMOTION_EVIDENCE_REQUIRED: ${gate.reasons.join("; ")}`
    );
  }

  if (family.active_revision_id === revisionIdInput) {
    const existing = [...family.lifecycle_events]
      .reverse()
      .find(
        (event) =>
          event.to_revision_id === revisionIdInput
      );
    if (existing) return structuredClone(existing);
  }

  const event: SiteSkillLifecycleEvent = {
    event_id: nextLifecycleEventId(family),
    recorded_at: recordedAt || new Date().toISOString(),
    kind: "promotion",
    ...(family.active_revision_id
      ? { from_revision_id: family.active_revision_id }
      : {}),
    to_revision_id: revisionIdInput
  };
  family.active_revision_id = revisionIdInput;
  family.lifecycle_events.push(event);
  await persistLibrary(library);
  return structuredClone(event);
}

export async function rollbackSiteSkillRevision(
  id: string,
  revisionIdInput: string,
  recordedAt?: string
): Promise<SiteSkillLifecycleEvent> {
  const library = await loadStoredLibrary();
  const family = library.families.find(
    (item) => item.id === id
  );
  if (!family) {
    throw new Error("SITE_SKILL_NOT_FOUND");
  }
  if (
    !family.revisions.some(
      (revision) =>
        revision.revision_id === revisionIdInput
    )
  ) {
    throw new Error("SITE_SKILL_REVISION_NOT_FOUND");
  }
  const previouslyActive = family.lifecycle_events.some(
    (event) =>
      event.to_revision_id === revisionIdInput
  );
  if (!previouslyActive) {
    throw new Error(
      "SITE_SKILL_ROLLBACK_TARGET_NOT_PREVIOUSLY_ACTIVE"
    );
  }

  const event: SiteSkillLifecycleEvent = {
    event_id: nextLifecycleEventId(family),
    recorded_at: recordedAt || new Date().toISOString(),
    kind: "rollback",
    ...(family.active_revision_id
      ? { from_revision_id: family.active_revision_id }
      : {}),
    to_revision_id: revisionIdInput
  };
  family.active_revision_id = revisionIdInput;
  family.lifecycle_events.push(event);
  await persistLibrary(library);
  return structuredClone(event);
}

export async function deleteSiteSkillCandidate(
  id: string
): Promise<boolean> {
  const library = await loadStoredLibrary();
  const next = library.families.filter(
    (candidate) => candidate.id !== id
  );
  if (next.length === library.families.length) return false;
  await persistLibrary({
    schema_version: 2,
    families: next
  });
  return true;
}

export async function listSiteSkillCandidateSummaries(): Promise<
  SiteSkillCandidateSummary[]
> {
  const library = await loadStoredLibrary();

  return library.families
    .map((family) => {
      const revision = latestRevision(family);
      const candidate = revision?.candidate;
      if (!candidate || !revision) return null;
      const verification = latestEvaluation(
        family,
        revision.revision_id,
        "structural-verification"
      );

      return {
        id: candidate.id,
        name: candidate.name,
        slug: candidate.slug,
        status: candidate.status,
        origin: candidate.site.origin,
        entry_url: candidate.site.entry_url,
        recipe_count: candidate.recipes.length,
        parameter_count: candidate.parameters.length,
        captured_at: candidate.provenance.captured_at,
        lifecycle_status: family.active_revision_id
          ? "active"
          : "candidate",
        revision_count: family.revisions.length,
        latest_revision_id: family.latest_revision_id,
        ...(family.active_revision_id
          ? { active_revision_id: family.active_revision_id }
          : {}),
        ...(verification
          ? {
              verification_status:
                verification.outcome === "passed"
                  ? "verified"
                  : "failed"
            }
          : {})
      } satisfies SiteSkillCandidateSummary;
    })
    .filter(
      (
        summary
      ): summary is SiteSkillCandidateSummary =>
        Boolean(summary)
    );
}

export const SITE_SKILL_CANDIDATES_KEY = LEGACY_KEY;
export const SITE_SKILL_LIBRARY_KEY = KEY;
