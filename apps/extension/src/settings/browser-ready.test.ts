import { beforeEach, describe, expect, it } from "vitest";
import { createConnection, loadConnections, markBrowserReady, saveConnection } from "./provider-store";
import { browserLabel } from "../ui/ModelMenu";

let store: Record<string, unknown>;
beforeEach(() => {
  store = {};
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          get: async (keys: string | string[]) =>
            Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, store[key]])),
          set: async (value: Record<string, unknown>) => {
            Object.assign(store, value);
          }
        }
      }
    }
  });
});

describe("browser-ready models", () => {
  it("marks a model browser-ready in place after a real task", async () => {
    const first = createConnection({ provider: "openai", apiKey: "k", model: "gpt-a" });
    const second = createConnection({ provider: "openai", apiKey: "k", model: "gpt-b" });
    await saveConnection(second);
    await saveConnection(first);
    await markBrowserReady(second.id, new Date("2026-10-05T10:00:00Z"));
    const [a, b] = await loadConnections();
    expect(a.id).toBe(first.id);
    expect(b.agentHealth).toEqual({ status: "healthy", checkedAt: "2026-10-05T10:00:00.000Z", message: "Finished a browser task" });
    expect(a.agentHealth.status).toBe("unknown");
  });

  it("labels models only from real evidence", () => {
    expect(browserLabel({ status: "healthy" })).toBe("✓ Browser-ready");
    expect(browserLabel({ status: "failed" })).toMatch(/^Chat only/);
    expect(browserLabel({ status: "unknown" })).toBeUndefined();
    expect(browserLabel(undefined)).toBeUndefined();
  });
});
