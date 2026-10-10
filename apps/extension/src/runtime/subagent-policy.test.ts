import { describe, expect, it, vi } from "vitest";
import type {
  ToolName,
  ToolResult
} from "./protocol";
import type {
  BrowserToolExecution
} from "./browser-engine";
import {
  newReadOnlyWorkerToolState,
  readOnlyWorkerToolPolicy,
  runReadOnlyWorkerTool
} from "./subagent-policy";

function genericTool(
  mock: ReturnType<typeof vi.fn>
) {
  return async <T = unknown>(
    tool: ToolName,
    input?: Record<string, unknown>,
    execution?: BrowserToolExecution
  ): Promise<ToolResult<T>> =>
    (await mock(
      tool,
      input,
      execution
    )) as ToolResult<T>;
}

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
        { action: "promote", id: "SK-1" },
        state
      ).allowed
    ).toBe(false);
    // a run is allowed here and narrowed to learned API reads when it is forwarded
    expect(
      readOnlyWorkerToolPolicy(
        "site_skill",
        { action: "run", id: "SK-1" },
        state
      ).allowed
    ).toBe(true);
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
      genericTool(baseTool)
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
      genericTool(baseTool)
    );

    expect(baseTool).toHaveBeenCalledWith(
      "mcp",
      expect.any(Object),
      undefined
    );
  });
});

describe("acting helper tool policy", () => {
  it("acts only in tabs the helper opened, never in the person's tabs", async () => {
    const state = newReadOnlyWorkerToolState();
    const mock = vi.fn(async (tool: ToolName) =>
      tool === "open_tab" ? { ok: true, data: { tab_id: 77 } } : { ok: true, data: {} }
    );
    const run = (tool: ToolName, input: Record<string, unknown> = {}, execution?: BrowserToolExecution) =>
      runReadOnlyWorkerTool(tool, input, execution, state, genericTool(mock), "act");

    // Not yet in its own tab: a correction the helper can recover from, not the end of its run.
    const early = await run("click", { element_id: "@e1" });
    expect(early).toMatchObject({ ok: false, error: { code: "HELPER_NEEDS_OWN_TAB" } });
    expect((early as { error: { message: string } }).error.message).toMatch(/only in tabs they opened/);

    await run("open_tab", { url: "https://shop.example/", active: true });
    expect(mock).toHaveBeenLastCalledWith("open_tab", { url: "https://shop.example/", active: false }, undefined);

    expect(await run("click", { element_id: "@e1" }, { approvalGranted: true })).toMatchObject({ ok: true });
    // An approved step carries its approval through to Chrome.
    expect(mock).toHaveBeenLastCalledWith("click", { element_id: "@e1" }, { approvalGranted: true });
    expect(await run("type", { element_id: "@e2", text: "green tea" })).toMatchObject({ ok: true });
    expect(await run("click", { element_id: "@e1", tab_id: 5 })).toMatchObject({ ok: false });
    expect(await run("switch_tab", { tab_id: 5 })).toMatchObject({ ok: false });
    expect(await run("switch_tab", { tab_id: 77 })).toMatchObject({ ok: true });

    for (const tool of ["evaluate", "cdp", "upload", "agent", "await_user_action"] as ToolName[]) {
      expect(await run(tool, {})).toMatchObject({ ok: false, error: { code: "SUBAGENT_SCOPE_DENIED" } });
    }
    // a Skill run goes through only as a learned API read; the run itself refuses anything else
    await run("site_skill", { action: "run", id: "SK" });
    expect(mock).toHaveBeenLastCalledWith("site_skill", { action: "run", id: "SK", api_read_only: true }, undefined);
    expect(await run("memory", { action: "save" })).toMatchObject({ ok: false });
  });

  it("read-only workers still never click, and never forward an approval", async () => {
    const state = newReadOnlyWorkerToolState();
    const mock = vi.fn(async (tool: ToolName) =>
      tool === "open_tab" ? { ok: true, data: { tab_id: 9 } } : { ok: true, data: {} }
    );
    await runReadOnlyWorkerTool("open_tab", {}, undefined, state, genericTool(mock));
    expect(await runReadOnlyWorkerTool("click", { element_id: "@e1" }, { approvalGranted: true }, state, genericTool(mock))).toMatchObject({ ok: false });
    await runReadOnlyWorkerTool("navigate", { url: "https://a.example" }, { approvalGranted: true }, state, genericTool(mock));
    expect(mock).toHaveBeenLastCalledWith("navigate", { url: "https://a.example" }, undefined);
  });
});
