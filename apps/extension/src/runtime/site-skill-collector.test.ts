import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureAxSnapshot: vi.fn(),
  evaluatePageExpression: vi.fn(),
  networkCaptureActive: vi.fn(),
  listNetworkRecords: vi.fn()
}));

vi.mock("../background/cdp-semantic", () => ({
  captureAxSnapshot: mocks.captureAxSnapshot
}));
vi.mock("../background/page-evaluate", () => ({
  evaluatePageExpression: mocks.evaluatePageExpression
}));
vi.mock("../background/network-capture", () => ({
  networkCaptureActive: mocks.networkCaptureActive,
  listNetworkRecords: mocks.listNetworkRecords
}));

import { collectCurrentSiteSkill } from "./site-skill-collector";

describe("Site -> Skill collector", () => {
  beforeEach(() => {
    mocks.captureAxSnapshot.mockReset();
    mocks.evaluatePageExpression.mockReset();
    mocks.networkCaptureActive.mockReset();
    mocks.listNetworkRecords.mockReset();

    mocks.captureAxSnapshot.mockResolvedValue({
      text: "",
      elements: [
        {
          element_id: "@e1",
          backend_node_id: 11,
          role: "textbox",
          name: "Query",
          disabled: false,
          focused: false
        }
      ]
    });
    mocks.evaluatePageExpression.mockResolvedValue({
      type: "object",
      value: [
        {
          index: 0,
          id: "search",
          action: "https://example.com/search",
          method: "GET",
          fields: [
            {
              tag: "input",
              type: "search",
              name: "q",
              id: "q",
              accessible_name: "Query",
              required: true
            }
          ],
          submit: {
            accessible_name: "Search",
            id: "submit"
          }
        }
      ]
    });
    mocks.networkCaptureActive.mockReturnValue(true);
    mocks.listNetworkRecords.mockReturnValue([
      {
        request_id: "r1",
        url: "https://example.com/api/search?q=x",
        method: "GET",
        started_at: 1
      }
    ]);
  });

  it("collects fresh AX/form/network evidence and compiles a candidate", async () => {
    const result = await collectCurrentSiteSkill({
      tab_id: 7,
      url: "https://example.com/",
      title: "Example Search",
      requested_name: "Example search",
      evidence_id: "site-1",
      captured_at: "2026-09-28T02:00:00.000Z"
    });

    expect(result.candidate).toMatchObject({
      id: "SK-SITE-SITE-1",
      name: "Example search",
      status: "candidate"
    });
    expect(result.candidate.recipes).toHaveLength(1);
    expect(result.evidence.network).toHaveLength(1);
    expect(mocks.captureAxSnapshot).toHaveBeenCalledWith(7, 1000);
    expect(mocks.evaluatePageExpression).toHaveBeenCalledWith(
      7,
      expect.stringContaining("document.forms"),
      80_000
    );
  });

  it("does not require network capture to create a structural candidate", async () => {
    mocks.networkCaptureActive.mockReturnValue(false);

    const result = await collectCurrentSiteSkill({
      tab_id: 7,
      url: "https://example.com/",
      title: "Example Search",
      evidence_id: "site-2",
      captured_at: "2026-09-28T02:00:00.000Z"
    });

    expect(result.evidence.network).toEqual([]);
    expect(mocks.listNetworkRecords).not.toHaveBeenCalled();
  });
});
