import type { SiteCandidateSkill } from "./site-skill";

const KEY = "browsercrew.siteSkillCandidates.v1";
const MAX_CANDIDATES = 100;

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
}

export async function loadSiteSkillCandidates(): Promise<
  SiteCandidateSkill[]
> {
  const stored = await chrome.storage.local.get(KEY);
  return Array.isArray(stored[KEY])
    ? (stored[KEY] as SiteCandidateSkill[])
    : [];
}

export async function saveSiteSkillCandidate(
  candidate: SiteCandidateSkill
): Promise<void> {
  const current = await loadSiteSkillCandidates();
  await chrome.storage.local.set({
    [KEY]: [
      candidate,
      ...current.filter((item) => item.id !== candidate.id)
    ].slice(0, MAX_CANDIDATES)
  });
}

export async function getSiteSkillCandidate(
  id: string
): Promise<SiteCandidateSkill | null> {
  return (
    (await loadSiteSkillCandidates()).find(
      (candidate) => candidate.id === id
    ) || null
  );
}

export async function deleteSiteSkillCandidate(
  id: string
): Promise<boolean> {
  const current = await loadSiteSkillCandidates();
  const next = current.filter((candidate) => candidate.id !== id);
  if (next.length === current.length) return false;
  await chrome.storage.local.set({ [KEY]: next });
  return true;
}

export async function listSiteSkillCandidateSummaries(): Promise<
  SiteSkillCandidateSummary[]
> {
  return (await loadSiteSkillCandidates()).map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    slug: candidate.slug,
    status: candidate.status,
    origin: candidate.site.origin,
    entry_url: candidate.site.entry_url,
    recipe_count: candidate.recipes.length,
    parameter_count: candidate.parameters.length,
    captured_at: candidate.provenance.captured_at,
    ...(candidate.verification
      ? { verification_status: candidate.verification.status }
      : {})
  }));
}

export const SITE_SKILL_CANDIDATES_KEY = KEY;
