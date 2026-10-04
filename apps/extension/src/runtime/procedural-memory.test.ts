import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listProceduralMemory,
  proceduralEmbeddingText,
  searchProceduralMemory
} from "./procedural-memory";
import {
  promoteSiteSkillRevision,
  recordSiteSkillEvaluation,
  recordSiteSkillExecutionEvidence,
  saveSiteSkillCandidate
} from "./site-skill-store";
import type { SiteCandidateSkill } from "./site-skill";
import * as providerStore from "../settings/provider-store";
import * as modelClient from "./model-client";

let store: Record<string, unknown>;

function candidate(
  id: string,
  name: string,
  targetName: string
): SiteCandidateSkill {
  return {
    schema_version: 1,
    id,
    slug: name.toLowerCase().replace(/\s+/g, "-"),
    name,
    version: "0.1.0",
    status: "candidate",
    lifecycle: {
      auto_promote: false,
      promotion_requires_evaluation: true
    },
    site: {
      origin: "https://shop.example",
      entry_url: "https://shop.example/checkout",
      title: name
    },
    parameters: [
      {
        name: "email",
        label: "Email",
        type: "string",
        required: true,
        sensitive: false,
        source: {
          form_index: 0,
          field_name: "email"
        }
      }
    ],
    recipes: [
      {
        id: "recipe-form-1",
        name: name,
        entry_url: "https://shop.example/checkout",
        form_index: 0,
        method: "POST",
        action: "https://shop.example/submit",
        parameters: ["email"],
        steps: [
          {
            kind: "input",
            form_index: 0,
            input_mode: "type",
            parameter: "email",
            target: {
              role: "textbox",
              accessible_name: "Email",
              tag: "input",
              input_type: "email",
              selector_hints: {
                name: "email"
              },
              resolution: "fresh_semantic_then_dom_hint"
            }
          },
          {
            kind: "submit",
            form_index: 0,
            target: {
              role: "button",
              accessible_name: targetName,
              tag: "button",
              selector_hints: {},
              resolution: "fresh_semantic_then_dom_hint"
            },
            method: "POST",
            action: "https://shop.example/submit",
            approval: "browserharness_runtime"
          }
        ],
        verification: {
          required: true,
          checks: [
            {
              kind: "form_present",
              expect: {
                action: "https://shop.example/submit",
                method: "POST"
              }
            }
          ]
        }
      }
    ],
    network_candidates: [],
    safety: {
      execution_requires_fresh_resolution: true,
      approval_policy: "preserve_browserharness_approval_rules",
      structural_analysis_is_not_execution_proof: true
    },
    provenance: {
      source_kind: "site_analysis_v1",
      evidence_id: name.replace(/\s+/g, "-"),
      captured_at: "2026-09-28T11:00:00.000Z",
      ax_target_count: 2,
      form_count: 1,
      network_request_count: 0
    }
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  store = {};
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          get: async (key: string | string[]) => {
            const keys = Array.isArray(key) ? key : [key];
            return Object.fromEntries(
              keys.map((name) => [name, store[name]])
            );
          },
          set: async (value: Record<string, unknown>) => {
            Object.assign(store, structuredClone(value));
          }
        }
      }
    }
  });

  vi.spyOn(
    providerStore,
    "loadEmbeddingConnection"
  ).mockResolvedValue({
    id: "embed-1",
    label: "Local embeddings",
    provider: "openai-compatible",
    apiKey: "x",
    model: "bge-small-en",
    baseUrl: "http://127.0.0.1:1234/v1",
    capabilities: {
      chat: false,
      agent: false,
      vision: false,
      embedding: true,
      reranker: false,
      audio: false,
      image: false,
      unknown: false
    },
    chatHealth: { status: "unknown" },
    agentHealth: { status: "unknown" },
    embeddingHealth: { status: "healthy" }
  });
});

async function activeAndCandidate() {
  await saveSiteSkillCandidate(
    candidate("SK-SITE-1", "Checkout", "Place order"),
    { reason: "create" }
  );
  await recordSiteSkillEvaluation(
    "SK-SITE-1",
    "SK-SITE-1:r1",
    {
      kind: "structural-verification",
      outcome: "passed"
    }
  );
  await recordSiteSkillEvaluation(
    "SK-SITE-1",
    "SK-SITE-1:r1",
    {
      kind: "execution",
      outcome: "passed"
    }
  );
  await recordSiteSkillExecutionEvidence(
    "SK-SITE-1",
    "SK-SITE-1:r1",
    {
      recipe_id: "recipe-form-1",
      started_at: "2026-09-28T11:01:00.000Z",
      outcome: "passed",
      executed_steps: 2,
      submitted: true
    }
  );
  await promoteSiteSkillRevision(
    "SK-SITE-1",
    "SK-SITE-1:r1"
  );

  const refined = candidate(
    "SK-SITE-1",
    "Express Checkout",
    "Complete order"
  );
  refined.provenance.evidence_id = "refined";
  refined.provenance.captured_at =
    "2026-09-28T11:05:00.000Z";
  await saveSiteSkillCandidate(refined, {
    reason: "refinement"
  });
  await recordSiteSkillEvaluation(
    "SK-SITE-1",
    "SK-SITE-1:r2",
    {
      kind: "structural-verification",
      outcome: "passed"
    }
  );
}

describe("procedural memory", () => {
  it("keeps active and latest candidate revisions distinct with evidence", async () => {
    await activeAndCandidate();

    const records = await listProceduralMemory();

    expect(records).toHaveLength(2);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          revision_id: "SK-SITE-1:r1",
          active: true,
          latest: false,
          lifecycle: "active",
          structural_verification: "passed",
          latest_execution: "passed",
          execution_runs: 1,
          execution_success_rate: 1,
          promotion_eligible: true
        }),
        expect.objectContaining({
          revision_id: "SK-SITE-1:r2",
          active: false,
          latest: true,
          lifecycle: "candidate",
          structural_verification: "passed",
          latest_execution: "missing",
          promotion_eligible: false
        })
      ])
    );
  });

  it("embeds only procedure contracts and evidence metadata", async () => {
    await activeAndCandidate();
    const [procedure] = await listProceduralMemory();
    const text = proceduralEmbeddingText(procedure);

    expect(text).toContain("Checkout");
    expect(text).toContain("Place order");
    expect(text).toContain("verification: passed");
    expect(text).not.toContain("user@example.com");
  });

  it("uses semantic retrieval while preserving exact revision provenance", async () => {
    await activeAndCandidate();

    vi.spyOn(modelClient, "embedTexts").mockImplementation(
      async (_config, inputs) => {
        if (
          inputs.length === 1 &&
          inputs[0] === "fast purchase"
        ) {
          return {
            vectors: [[0, 1]],
            dimensions: 2
          };
        }

        return {
          vectors: inputs.map((text) =>
            text.includes("Express Checkout")
              ? [0, 1]
              : [1, 0]
          ),
          dimensions: 2
        };
      }
    );

    const hits = await searchProceduralMemory(
      "fast purchase",
      2
    );

    expect(hits[0]).toMatchObject({
      procedure: {
        skill_id: "SK-SITE-1",
        revision_id: "SK-SITE-1:r2"
      },
      semantic_rank: 1
    });
    expect(hits[0].retrieval).toContain("semantic");
  });

  it("uses explicit evidence only as a small tie preference", async () => {
    await activeAndCandidate();
    vi.mocked(
      providerStore.loadEmbeddingConnection
    ).mockResolvedValue(null);

    const hits = await searchProceduralMemory(
      "shop.example",
      2
    );

    expect(hits[0].procedure.revision_id).toBe(
      "SK-SITE-1:r1"
    );
    expect(hits[0].evidence_preference).toBeGreaterThan(
      hits[1].evidence_preference
    );
  });
});
