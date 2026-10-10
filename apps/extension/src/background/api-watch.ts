// Watch Me as a source for API learning. While a person records, the root
// tab's network is captured; when the recording stops, that capture and the
// values the person typed are kept in memory for a short while, so
// site_skill learn_api can learn the request the demonstration made
// (from_watch). Nothing here is written to storage: the capture holds cookies
// and page storage, and it is dropped once it is learned from or expires.
import type { ApiCapture } from "./api-capture";
import { inferWorkflowInputs, type RecordedWorkflowStep } from "../runtime/workflows";

export const WATCH_CAPTURE_TTL_MS = 15 * 60 * 1000;

export interface WatchApiCapture {
  recording_id: string;
  start_url: string;
  capture: ApiCapture;
  /** what the person typed, by input name; never a password or a card field */
  examples: Record<string, string>;
  kept_at: number;
}

const pending = new Map<string, { tab_id: number; started_capture: boolean }>();
const kept = new Map<string, WatchApiCapture>();

const SECRET_FIELD = /pass(word|code)?|secret|otp|one.?time|verification.?code|auth.?code|2fa|mfa|\bpin\b|cvv|cvc|card.?(number|no)|security.?code|token|ssn/i;

/** The inputs a demonstration typed, by name, skipping passwords and other secrets. */
export function examplesFromSteps(steps: RecordedWorkflowStep[]): Record<string, string> {
  const typed = steps.filter((step): step is Extract<RecordedWorkflowStep, { action: "type" }> => step.action === "type");
  const out: Record<string, string> = {};
  for (const input of inferWorkflowInputs(typed)) {
    const step = typed.find((item) => item.id === input.step_id) || typed.find((item) => item.text === input.default);
    const locator = step?.locator;
    const described = [input.name, input.label, locator?.attributes?.name, locator?.attributes?.autocomplete, locator?.attributes?.id].filter(Boolean).join(" ");
    if (locator?.input_type === "password" || SECRET_FIELD.test(described)) continue;
    const value = input.default.trim();
    if (value) out[input.name] = value;
  }
  return out;
}

export function noteWatchStart(recordingId: string, tabId: number, startedCapture: boolean): void {
  pending.set(recordingId, { tab_id: tabId, started_capture: startedCapture });
}

/** The tab a recording captured, and whether the capture was started for it. */
export function takeWatchStart(recordingId: string): { tab_id: number; started_capture: boolean } | undefined {
  const value = pending.get(recordingId);
  pending.delete(recordingId);
  return value;
}

function sweep(now: number): void {
  for (const [id, entry] of kept) if (now - entry.kept_at > WATCH_CAPTURE_TTL_MS) kept.delete(id);
}

export function keepWatchCapture(entry: Omit<WatchApiCapture, "kept_at">, now = Date.now()): WatchApiCapture {
  sweep(now);
  const value = { ...entry, kept_at: now };
  kept.set(entry.recording_id, value);
  return value;
}

export function watchCapture(recordingId: string, now = Date.now()): WatchApiCapture | null {
  sweep(now);
  return kept.get(recordingId) || null;
}

export function forgetWatchCapture(recordingId: string): void {
  kept.delete(recordingId);
}

/** What the Watch Me result says about the capture: counts and input names, no values. */
export function watchCaptureSummary(entry: WatchApiCapture) {
  const requests = entry.capture.exchanges.filter((exchange) => exchange.resource_type === "xhr" || exchange.resource_type === "fetch").length;
  const inputs = Object.keys(entry.examples);
  return {
    recording_id: entry.recording_id,
    data_requests: requests,
    inputs,
    kept_minutes: WATCH_CAPTURE_TTL_MS / 60_000,
    next:
      requests && inputs.length
        ? `To learn the request this made: site_skill learn_api with name and from_watch: ["${entry.recording_id}"] (record it again with a different ${inputs[0]} and pass both ids to tell inputs from constants).`
        : requests
          ? "The demonstration typed nothing, so there is no input to find in its requests."
          : "The demonstration made no data requests to learn from."
  };
}
