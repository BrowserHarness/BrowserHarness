import { beforeEach, describe, expect, it } from "vitest";
import {
  getMcpServerTrustMode,
  listMcpServerTrustPolicies,
  setMcpServerTrustMode
} from "./mcp-trust-store";

let store: Record<string, unknown>;

beforeEach(() => {
  store = {};
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          get: async (key: string) => ({
            [key]: store[key]
          }),
          set: async (value: Record<string, unknown>) => {
            Object.assign(store, structuredClone(value));
          }
        }
      }
    }
  });
});

describe("MCP server trust store", () => {
  it("defaults unknown servers to allow-read-only", async () => {
    expect(
      await getMcpServerTrustMode("notes")
    ).toBe("allow-read-only");
  });

  it("persists blocked ask-all and allow-read-only modes", async () => {
    await setMcpServerTrustMode("notes", "ask-all");
    await setMcpServerTrustMode("payments", "blocked");

    expect(
      await getMcpServerTrustMode("notes")
    ).toBe("ask-all");
    expect(
      await getMcpServerTrustMode("payments")
    ).toBe("blocked");

    expect(await listMcpServerTrustPolicies()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          server_id: "notes",
          mode: "ask-all"
        }),
        expect.objectContaining({
          server_id: "payments",
          mode: "blocked"
        })
      ])
    );
  });
});
