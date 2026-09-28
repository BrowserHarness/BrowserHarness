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

export interface SiteSkillFamilyRecord {
  id: string;
  slug: string;
  name: string;
  latest_revision_id: string;
  active_revision_id?: string;
  revisions: SiteSkillRevisionRecord[];
}

export interface SiteSkillLibrary {
  schema_version: 2;
  families: SiteSkillFamilyRecord[];
}

export interface SaveSiteSkillCandidateOptions {
  reason?: SiteSkillRevisionReason;
  created_at?: string;
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
    revisions: [revision]
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
    return structuredClone(current[KEY]);
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
      revisions: []
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

export async function getSiteSkillCandidate(
  id: string,
  revisionIdInput?: string
): Promise<SiteCandidateSkill | null> {
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
      const candidate = latestRevision(family)?.candidate;
      if (!candidate) return null;

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
        revision_count: family.revisions.length,
        latest_revision_id: family.latest_revision_id,
        ...(family.active_revision_id
          ? { active_revision_id: family.active_revision_id }
          : {}),
        ...(candidate.verification
          ? {
              verification_status:
                candidate.verification.status
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
