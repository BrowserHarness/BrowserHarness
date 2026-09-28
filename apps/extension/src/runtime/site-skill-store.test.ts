import { beforeEach, describe, expect, it } from "vitest";
import {
  deleteSiteSkillCandidate,
  getSiteSkillCandidate,
  getSiteSkillFamily,
  listSiteSkillCandidateSummaries,
  listSiteSkillRevisionSummaries,
  listSiteSkillRevisions,
  loadSiteSkillCandidates,
  saveSiteSkillCandidate,
  SITE_SKILL_CANDIDATES_KEY,
  SITE_SKILL_LIBRARY_KEY
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
            Object.assign(store, structuredClone(value));
          }
        }
      }
    }
  });
});

describe("versioned Site Skill storage", () => {
  it("persists the first candidate as immutable revision r1", async () => {
    const saved = await saveSiteSkillCandidate(
      candidate("SK-SITE-1"),
      {
        reason: "create",
        created_at: "2026-09-28T03:00:00.000Z"
      }
    );

    expect(saved).toMatchObject({
      revision_id: "SK-SITE-1:r1",
      ordinal: 1,
      reason: "create"
    });
    expect(await loadSiteSkillCandidates()).toHaveLength(1);
    expect(await listSiteSkillCandidateSummaries()).toEqual([
      expect.objectContaining({
        id: "SK-SITE-1",
        status: "candidate",
        origin: "https://example.com",
        revision_count: 1,
        latest_revision_id: "SK-SITE-1:r1"
      })
    ]);
    expect(
      await listSiteSkillRevisionSummaries("SK-SITE-1")
    ).toEqual([
      {
        revision_id: "SK-SITE-1:r1",
        ordinal: 1,
        created_at: "2026-09-28T03:00:00.000Z",
        reason: "create",
        name: "Example",
        status: "candidate"
      }
    ]);

    const family = await getSiteSkillFamily("SK-SITE-1");
    expect(family?.active_revision_id).toBeUndefined();
  });

  it("appends a child revision instead of destructively replacing the prior snapshot", async () => {
    await saveSiteSkillCandidate(
      candidate("SK-SITE-1", "Old"),
      {
        reason: "create",
        created_at: "2026-09-28T03:00:00.000Z"
      }
    );

    const updated = candidate("SK-SITE-1", "Updated");
    updated.provenance.evidence_id = "ev-2";
    updated.provenance.captured_at = "2026-09-28T03:05:00.000Z";

    await saveSiteSkillCandidate(updated, {
      reason: "refinement",
      created_at: "2026-09-28T03:05:00.000Z"
    });

    const revisions = await listSiteSkillRevisions("SK-SITE-1");
    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toMatchObject({
      revision_id: "SK-SITE-1:r1",
      ordinal: 1,
      reason: "create",
      candidate: {
        name: "Old"
      }
    });
    expect(revisions[1]).toMatchObject({
      revision_id: "SK-SITE-1:r2",
      ordinal: 2,
      parent_revision_id: "SK-SITE-1:r1",
      reason: "refinement",
      candidate: {
        name: "Updated"
      }
    });

    expect(
      (await getSiteSkillCandidate("SK-SITE-1"))?.name
    ).toBe("Updated");
    expect(
      (
        await getSiteSkillCandidate(
          "SK-SITE-1",
          "SK-SITE-1:r1"
        )
      )?.name
    ).toBe("Old");
  });

  it("does not create a duplicate revision for an identical snapshot", async () => {
    const value = candidate("SK-SITE-1");
    const first = await saveSiteSkillCandidate(value, {
      reason: "create"
    });
    const second = await saveSiteSkillCandidate(
      structuredClone(value),
      {
        reason: "snapshot"
      }
    );

    expect(second.revision_id).toBe(first.revision_id);
    expect(
      await listSiteSkillRevisions("SK-SITE-1")
    ).toHaveLength(1);
  });

  it("reads legacy v1 candidates and migrates them into revision history on the next write", async () => {
    store[SITE_SKILL_CANDIDATES_KEY] = [
      candidate("SK-SITE-LEGACY", "Legacy")
    ];

    expect(
      (await loadSiteSkillCandidates())[0]?.name
    ).toBe("Legacy");
    expect(
      await listSiteSkillRevisions("SK-SITE-LEGACY")
    ).toEqual([
      expect.objectContaining({
        revision_id: "SK-SITE-LEGACY:r1",
        reason: "migration",
        candidate: expect.objectContaining({
          name: "Legacy"
        })
      })
    ]);

    const updated = candidate(
      "SK-SITE-LEGACY",
      "Legacy updated"
    );
    updated.provenance.evidence_id = "ev-2";
    updated.provenance.captured_at =
      "2026-09-28T04:00:00.000Z";

    await saveSiteSkillCandidate(updated, {
      reason: "refinement"
    });

    expect(store[SITE_SKILL_LIBRARY_KEY]).toBeDefined();
    expect(
      await listSiteSkillRevisions("SK-SITE-LEGACY")
    ).toEqual([
      expect.objectContaining({
        revision_id: "SK-SITE-LEGACY:r1",
        reason: "migration"
      }),
      expect.objectContaining({
        revision_id: "SK-SITE-LEGACY:r2",
        parent_revision_id: "SK-SITE-LEGACY:r1",
        reason: "refinement"
      })
    ]);
  });

  it("gets and deletes the full Skill family", async () => {
    await saveSiteSkillCandidate(candidate("SK-SITE-2"), {
      reason: "create"
    });

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
      listSiteSkillRevisions("SK-SITE-2")
    ).resolves.toEqual([]);
    await expect(
      deleteSiteSkillCandidate("missing")
    ).resolves.toBe(false);
  });
});
