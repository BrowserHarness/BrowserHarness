import { describe, expect, it } from "vitest";
import {
  compileSiteEvidenceToCandidate,
  createSiteSkillEvidence
} from "./site-skill";
import { verifySiteSkillCandidate } from "./site-skill-verifier";

function evidence(method = "POST", fieldName = "email") {
  return createSiteSkillEvidence({
    evidence_id: "ev-verify",
    captured_at: "2026-09-28T03:00:00.000Z",
    url: "https://example.com/signup",
    title: "Signup",
    ax: {
      text: "",
      elements: []
    },
    forms: [
      {
        index: 0,
        id: "signup",
        action: "https://example.com/signup",
        method,
        fields: [
          {
            tag: "input",
            type: "email",
            name: fieldName,
            id: fieldName,
            accessible_name: "Email",
            required: true
          }
        ],
        submit: {
          id: "submit",
          accessible_name: "Create account"
        }
      }
    ]
  });
}

describe("Site Skill verification", () => {
  it("verifies a candidate against fresh structural evidence", () => {
    const source = evidence();
    const candidate = compileSiteEvidenceToCandidate(
      source,
      "Signup"
    );

    const result = verifySiteSkillCandidate(
      candidate,
      evidence(),
      "2026-09-28T03:05:00.000Z"
    );

    expect(result.status).toBe("verified");
    expect(result.checks.every((check) => check.passed)).toBe(true);
  });

  it("fails verification when the form contract drifts", () => {
    const candidate = compileSiteEvidenceToCandidate(
      evidence(),
      "Signup"
    );

    const result = verifySiteSkillCandidate(
      candidate,
      evidence("GET", "different")
    );

    expect(result.status).toBe("failed");
    expect(
      result.checks.some(
        (check) => check.kind === "form" && !check.passed
      )
    ).toBe(true);
  });

  it("fails verification when the site origin changes", () => {
    const source = evidence();
    const candidate = compileSiteEvidenceToCandidate(source, "Signup");
    const changed = {
      ...source,
      evidence_id: "ev-other",
      site: {
        ...source.site,
        url: "https://other.example/signup",
        origin: "https://other.example"
      }
    };

    const result = verifySiteSkillCandidate(candidate, changed);
    expect(result.status).toBe("failed");
    expect(result.checks[0]).toMatchObject({
      kind: "origin",
      passed: false
    });
  });
});
