import { describe, expect, it, vi } from "vitest";
import {
  newReadOnlyWorkerToolState,
  readOnlyWorkerToolPolicy,
  runReadOnlyWorkerTool
} from "./subagent-policy";

describe("read-only worker tool policy", () => {
  it("allows passive reads but denies mutation and recursive agents", () => {
    const state = newReadOnlyWorkerToolState();

    expect(
      readOnlyWorkerToolPolicy(
        "read_page",
        {},
        state
      ).allowed
    ).toBe(true);
    expect(
      readOnlyWorkerToolPolicy(
        "click",
        { element_id: "@e1" },
        state
      ).allowed
    ).toBe(false);
    expect(
      readOnlyWorkerToolPolicy(
        "agent",
        { task: "nested" },
        state
      ).allowed
    ).toBe(false);
    expect(
      readOnlyWorkerToolPolicy(
        "site_skill",
        { action: "run", id: "SK-1" },
        state
      ).allowed
    ).toBe(false);
  });

  it("requires a worker-owned tab before navigation", async () => {
    const state = newReadOnlyWorkerToolState();
    const baseTool = vi.fn(
      async (tool: string) =>
        tool === "open_tab"
          ? {
              ok: true,
              data: {
                tab_id: 44,
                owned: true
              }
            }
          : {
              ok: true,
              data: {}
            }
    );

    expect(
      readOnlyWorkerToolPolicy(
        "navigate",
        { url: "https://example.com" },
        state
      ).allowed
    ).toBe(false);

    await runReadOnlyWorkerTool(
      "open_tab",
      {
        url: "about:blank",
        active: true
      },
      undefined,
      state,
      baseTool
    );

    expect(state.owned_tab_ids.has(44)).toBe(true);
    expect(state.current_owned_tab_id).toBe(44);
    expect(
      readOnlyWorkerToolPolicy(
        "navigate",
        { url: "https://example.com" },
        state
      ).allowed
    ).toBe(true);
    expect(baseTool).toHaveBeenNthCalledWith(
      1,
      "open_tab",
      {
        url: "about:blank",
        active: false
      },
      undefined
    );
  });

  it("allows only non-mutating memory and Skill actions", () => {
    const state = newReadOnlyWorkerToolState();

    expect(
      readOnlyWorkerToolPolicy(
        "memory",
        { action: "search" },
        state
      ).allowed
    ).toBe(true);
    expect(
      readOnlyWorkerToolPolicy(
        "memory",
        { action: "delete" },
        state
      ).allowed
    ).toBe(false);
    expect(
      readOnlyWorkerToolPolicy(
        "site_skill",
        { action: "history" },
        state
      ).allowed
    ).toBe(true);
    expect(
      readOnlyWorkerToolPolicy(
        "site_skill",
        { action: "promote" },
        state
      ).allowed
    ).toBe(false);
  });

  it("never forwards an approval proof from a worker", async () => {
    const state = newReadOnlyWorkerToolState();
    const baseTool = vi.fn(async () => ({
      ok: true,
      data: {}
    }));

    await runReadOnlyWorkerTool(
      "mcp",
      {
        action: "call_tool",
        server_id: "notes",
        tool: "search_notes",
        arguments: {}
      },
      { approvalGranted: true },
      state,
      baseTool
    );

    expect(baseTool).toHaveBeenCalledWith(
      "mcp",
      expect.any(Object),
      undefined
    );
  });
});
