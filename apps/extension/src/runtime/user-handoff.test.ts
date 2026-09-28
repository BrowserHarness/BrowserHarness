import { beforeEach, describe, expect, it, vi } from "vitest";

type UpdatedListener = (
  tabId: number,
  changeInfo: chrome.tabs.TabChangeInfo,
  tab: chrome.tabs.Tab
) => void;
type RemovedListener = (tabId: number) => void;

const state = vi.hoisted(() => ({
  updated: new Set<UpdatedListener>(),
  removed: new Set<RemovedListener>(),
  get: vi.fn()
}));

vi.stubGlobal("chrome", {
  tabs: {
    get: state.get,
    onUpdated: {
      addListener: (listener: UpdatedListener) =>
        state.updated.add(listener),
      removeListener: (listener: UpdatedListener) =>
        state.updated.delete(listener)
    },
    onRemoved: {
      addListener: (listener: RemovedListener) =>
        state.removed.add(listener),
      removeListener: (listener: RemovedListener) =>
        state.removed.delete(listener)
    }
  }
});

import { waitForUserAction } from "./user-handoff";

describe("user handoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.updated.clear();
    state.removed.clear();
    state.get.mockReset();
    state.get.mockResolvedValue({
      id: 7,
      url: "https://example.com/login",
      status: "complete"
    });
  });

  it("resumes from navigation during the grace window without showing the prompt", async () => {
    const prompt = vi.fn();
    const pending = waitForUserAction({
      tab_id: 7,
      starting_url: "https://example.com/login",
      reason: "Sign in",
      prompt,
      grace_ms: 10_000
    });

    await Promise.resolve();
    for (const listener of state.updated) {
      listener(
        7,
        { status: "complete" },
        {
          id: 7,
          url: "https://example.com/account",
          status: "complete"
        }
      );
    }

    await expect(pending).resolves.toEqual({
      status: "continue",
      source: "navigation"
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(state.updated.size).toBe(0);
    expect(state.removed.size).toBe(0);
  });

  it("shows the takeover prompt after the grace window and resumes on user confirmation", async () => {
    const prompt = vi.fn(async () => "continue" as const);
    const pending = waitForUserAction({
      tab_id: 7,
      starting_url: "https://example.com/login",
      reason: "Complete two-factor authentication",
      prompt,
      grace_ms: 10_000
    });

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toEqual({
      status: "continue",
      source: "user"
    });
    expect(prompt).toHaveBeenCalledWith(
      "Complete two-factor authentication"
    );
  });

  it("keeps navigation watching active while the takeover prompt is visible", async () => {
    let resolvePrompt:
      | ((status: "continue" | "cancelled") => void)
      | undefined;
    const prompt = vi.fn(
      () =>
        new Promise<"continue" | "cancelled">((resolve) => {
          resolvePrompt = resolve;
        })
    );

    const pending = waitForUserAction({
      tab_id: 7,
      starting_url: "https://example.com/login",
      reason: "Finish login",
      prompt,
      grace_ms: 10_000
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(prompt).toHaveBeenCalledOnce();

    for (const listener of state.updated) {
      listener(
        7,
        { status: "complete" },
        {
          id: 7,
          url: "https://example.com/dashboard",
          status: "complete"
        }
      );
    }

    await expect(pending).resolves.toEqual({
      status: "continue",
      source: "navigation"
    });

    resolvePrompt?.("continue");
    await Promise.resolve();
    expect(state.updated.size).toBe(0);
  });

  it("stops when the user cancels the takeover", async () => {
    const pending = waitForUserAction({
      tab_id: 7,
      starting_url: "https://example.com/login",
      reason: "Complete CAPTCHA",
      prompt: async () => "cancelled",
      grace_ms: 0
    });

    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual({
      status: "cancelled",
      source: "user"
    });
  });

  it("aborts and cleans up listeners when the task stops", async () => {
    const controller = new AbortController();
    const pending = waitForUserAction({
      tab_id: 7,
      starting_url: "https://example.com/login",
      reason: "Sign in",
      prompt: () => new Promise(() => undefined),
      signal: controller.signal,
      grace_ms: 0
    });

    controller.abort();

    await expect(pending).rejects.toMatchObject({
      name: "AbortError"
    });
    expect(state.updated.size).toBe(0);
    expect(state.removed.size).toBe(0);
  });
});
