import { beforeEach, describe, expect, it } from "vitest";
import {
  clearTaskHistory,
  loadTaskHistory,
  saveTaskHistoryEntry
} from "./history";

let store: Record<string, unknown>;

beforeEach(() => {
  store = {
    "browserharness.preferences": {
      appearance: "system",
      retainTaskHistory: true
    }
  };
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: store[key] }),
          set: async (value: Record<string, unknown>) => {
            Object.assign(store, value);
          },
          remove: async (key: string) => {
            delete store[key];
          }
        }
      }
    }
  });
});

describe("task history privacy", () => {
  it("stores completed task history locally when enabled", async () => {
    await saveTaskHistoryEntry({
      task: "Summarize this page",
      result: "Summary",
      url: "https://example.com"
    });

    const history = await loadTaskHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      task: "Summarize this page",
      result: "Summary"
    });
  });

  it("does not retain history when privacy retention is disabled", async () => {
    store["browserharness.preferences"] = {
      appearance: "system",
      retainTaskHistory: false
    };

    await saveTaskHistoryEntry({
      task: "Private task",
      result: "Private result"
    });

    expect(await loadTaskHistory()).toEqual([]);
  });

  it("clears retained history", async () => {
    await saveTaskHistoryEntry({
      task: "Task",
      result: "Result"
    });
    await clearTaskHistory();
    expect(await loadTaskHistory()).toEqual([]);
  });
});

describe("searching past tasks", () => {
  const entries = [
    { id: "1", task: "Find cheap flights to Goa", result: "IndiGo ₹4,200", timestamp: "2026-10-05T10:00:00Z", url: "https://www.google.com/travel" },
    { id: "2", task: "Write a video script", result: "Done in Google Docs", timestamp: "2026-10-04T10:00:00Z" }
  ];

  it("matches every word across the task, answer and page", async () => {
    const { searchTaskHistory } = await import("./history");
    expect(searchTaskHistory(entries, "goa flights").map((entry) => entry.id)).toEqual(["1"]);
    expect(searchTaskHistory(entries, "docs").map((entry) => entry.id)).toEqual(["2"]);
    expect(searchTaskHistory(entries, "google").map((entry) => entry.id)).toEqual(["1", "2"]);
    expect(searchTaskHistory(entries, "  ")).toHaveLength(2);
    expect(searchTaskHistory(entries, "hotel")).toHaveLength(0);
  });
});
