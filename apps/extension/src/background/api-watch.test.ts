import { describe, expect, it } from "vitest";
import { examplesFromSteps, forgetWatchCapture, keepWatchCapture, watchCapture, watchCaptureSummary, WATCH_CAPTURE_TTL_MS } from "./api-watch";
import type { RecordedWorkflowStep } from "../runtime/workflows";
import type { ApiCapture } from "./api-capture";

function typed(id: string, label: string, text: string, extra: Record<string, unknown> = {}): RecordedWorkflowStep {
  return { id, action: "type", text, locator: { tag: "input", role: "textbox", accessible_name: label, label, ...extra } };
}

const capture: ApiCapture = {
  capture_version: 1,
  final_url: "https://shop.example/search?q=laptops",
  locations: ["https://shop.example/search?q=laptops"],
  exchanges: [
    { id: 1, resource_type: "document", request: { method: "GET", url: "https://shop.example/search?q=laptops", headers: {} } },
    { id: 2, resource_type: "fetch", request: { method: "GET", url: "https://shop.example/api/search?q=laptops", headers: {} } }
  ],
  cookies: [{ name: "sid", value: "secret-cookie", domain: "shop.example", path: "/", expires: -1, httpOnly: true, secure: true }],
  storage: {}
};

describe("Watch Me captures for API learning", () => {
  it("takes what was typed as examples, never a password, code or card field", () => {
    const steps: RecordedWorkflowStep[] = [
      typed("s1", "Search", " laptops "),
      typed("s2", "Password", "hunter2", { input_type: "password" }),
      typed("s3", "Verification code", "123456"),
      typed("s4", "Card number", "4111111111111111"),
      { id: "s5", action: "click", locator: { tag: "button", role: "button", accessible_name: "Go" } }
    ];
    expect(examplesFromSteps(steps)).toEqual({ search: "laptops" });
  });

  it("keeps a capture in memory for a while, then drops it", () => {
    const t0 = 1_000_000;
    keepWatchCapture({ recording_id: "rec-1", start_url: "https://shop.example/", capture, examples: { search: "laptops" } }, t0);
    expect(watchCapture("rec-1", t0 + 1000)?.examples).toEqual({ search: "laptops" });
    expect(watchCapture("rec-1", t0 + WATCH_CAPTURE_TTL_MS + 1)).toBeNull();
    keepWatchCapture({ recording_id: "rec-2", start_url: "https://shop.example/", capture, examples: {} }, t0);
    forgetWatchCapture("rec-2");
    expect(watchCapture("rec-2", t0)).toBeNull();
  });

  it("says what it holds by count and input name, without values", () => {
    const summary = watchCaptureSummary(keepWatchCapture({ recording_id: "rec-3", start_url: "https://shop.example/", capture, examples: { search: "laptops" } }));
    expect(summary).toMatchObject({ recording_id: "rec-3", data_requests: 1, inputs: ["search"], next: expect.stringContaining('from_watch: ["rec-3"]') });
    expect(JSON.stringify(summary)).not.toMatch(/laptops|secret-cookie/);
  });
});
