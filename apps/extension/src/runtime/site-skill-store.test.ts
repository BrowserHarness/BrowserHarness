import { beforeEach, describe, expect, it } from "vitest";
import {
  deleteSiteSkillCandidate,
  getSiteSkillCandidate,
  listSiteSkillCandidateSummaries,
  loadSiteSkillCandidates,
  saveSiteSkillCandidate
} from "./site-skill-store";
import type { SiteCandidateSkill } from "./site-skill";

let store: Record<string, unknown>;

function candidate(id: string, name = "Example"): SiteCandidateSkill {
  return {
    schema_version: 1,
    id,
    slug: name.toLowerCase(),
    name,
    version: "0.1.0",
    status: "candidate",
    lifecycle: {
      auto_promote: false,
      promotion_requires_evaluation: true
    },
    site: {
      origin: "https://example.com",
      entry_url: "https://example.com/",
      title: "Example"
    },
    parameters: [],
    recipes: [],
    network_candidates: [],
    safety: {
      execution_requires_fresh_resolution: true,
      approval_policy: "preserve_browsercrew_approval_rules",
      structural_analysis_is_not_execution_proof: true
    },
    provenance: {
      source_kind: "site_analysis_v1",
      evidence_id: "ev-1",
      captured_at: "2026-09-28T02:00:00.000Z",
      ax_target_count: 1,
      form_count: 1,
      network_request_count: 0
    }
  };
}

beforeEach(() => {
  store = {};
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: store[key] }),
          set: async (value: Record<string, unknown>) => {
            Object.assign(store, value);
          }
        }
      }
    }
  });
});

describe("Site Skill candidate storage", () => {
  it("persists and lists candidate metadata", async () => {
    await saveSiteSkillCandidate(candidate("SK-SITE-1"));

    expect(await loadSiteSkillCandidates()).toHaveLength(1);
    expect(await listSiteSkillCandidateSummaries()).toEqual([
      expect.objectContaining({
        id: "SK-SITE-1",
        status: "candidate",
        origin: "https://example.com"
      })
    ]);
  });

  it("replaces a candidate by id instead of duplicating it", async () => {
    await saveSiteSkillCandidate(candidate("SK-SITE-1", "Old"));
    await saveSiteSkillCandidate(candidate("SK-SITE-1", "Updated"));

    const saved = await loadSiteSkillCandidates();
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe("Updated");
  });

  it("gets and deletes candidates", async () => {
    await saveSiteSkillCandidate(candidate("SK-SITE-2"));

    expect((await getSiteSkillCandidate("SK-SITE-2"))?.id).toBe(
      "SK-SITE-2"
    );
    await expect(
      deleteSiteSkillCandidate("SK-SITE-2")
    ).resolves.toBe(true);
    await expect(
      getSiteSkillCandidate("SK-SITE-2")
    ).resolves.toBeNull();
    await expect(
      deleteSiteSkillCandidate("missing")
    ).resolves.toBe(false);
  });
});
