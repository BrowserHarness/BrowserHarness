import { describe, expect, it, vi } from "vitest";
import {
  runReadOnlySubagent
} from "./subagent-runner";
import type {
  PageObservation,
  ToolName,
  ToolResult
} from "./protocol";
import type {
  BrowserToolExecution
} from "./browser-engine";

function genericBaseTool(
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

function page(
  tab_id: number,
  title: string,
  url = "https://example.com"
): PageObservation {
  return {
    tab_id,
    url,
    title,
    visible_text: title,
    elements: []
  };
}

describe("read-only subagent runner", () => {
  it("returns bounded findings and always cleans the child session", async () => {
    const baseTool = vi.fn(
      async (
        tool: ToolName,
        _input?: Record<string, unknown>,
        _execution?: BrowserToolExecution
      ) => {
        if (tool === "observe_page") {
          return {
            ok: true,
            data: page(1, "Article")
          };
        }
        if (tool === "read_page") {
          return {
            ok: true,
            data: {
              text: "Evidence"
            }
          };
        }
        return {
          ok: true,
          data: {}
        };
      }
    );

    let turn = 0;
    const result = await runReadOnlySubagent(
      "Read the article",
      {
        session: {
          id: "worker-1",
          title: "Worker"
        },
        decide: async () => {
          turn += 1;
          return turn === 1
            ? {
                decision: {
                  kind: "tool",
                  tool: "read_page",
                  input: {},
                  note: "Reading"
                }
              }
            : {
                decision: {
                  kind: "final",
                  message: "Evidence found."
                }
              };
        },
        baseTool: genericBaseTool(baseTool),
        isCancelled: () => false,
        waitWhilePaused: async () => undefined
      }
    );

    expect(result).toMatchObject({
      status: "completed",
      message: "Evidence found.",
      session_id: "worker-1",
      sources: [
        {
          url: "https://example.com",
          title: "Article"
        }
      ],
      tools_used: ["read_page"]
    });
    expect(
      baseTool.mock.calls.some(
        ([tool]) => tool === "close_session"
      )
    ).toBe(true);
  });

  it("turns a disallowed worker action into a failed finding instead of mutating", async () => {
    const baseTool = vi.fn(
      async (
        tool: ToolName,
        _input?: Record<string, unknown>,
        _execution?: BrowserToolExecution
      ) =>
        tool === "observe_page"
          ? {
              ok: true,
              data: page(1, "Checkout")
            }
          : {
              ok: true,
              data: {}
            }
    );

    const result = await runReadOnlySubagent(
      "Try to change checkout",
      {
        session: {
          id: "worker-2",
          title: "Worker"
        },
        decide: async () => ({
          decision: {
            kind: "tool",
            tool: "click",
            input: {
              element_id: "@e1"
            },
            note: "Clicking"
          }
        }),
        baseTool: genericBaseTool(baseTool),
        isCancelled: () => false,
        waitWhilePaused: async () => undefined
      }
    );

    expect(result.status).toBe("failed");
    expect(result.message).toContain(
      "outside the read-only worker scope"
    );
    expect(
      baseTool.mock.calls.some(
        ([tool]) => tool === "click"
      )
    ).toBe(false);
  });

  it("does not forward worker approval to MCP writes", async () => {
    const baseTool = vi.fn(
      async (
        tool: ToolName,
        _input?: Record<string, unknown>,
        _execution?: BrowserToolExecution
      ) => {
        if (tool === "observe_page") {
          return {
            ok: true,
            data: page(1, "Notes")
          };
        }
        if (tool === "mcp") {
          return {
            ok: false,
            error: {
              code: "APPROVAL_REQUIRED",
              message: "Write requires approval"
            }
          };
        }
        return {
          ok: true,
          data: {}
        };
      }
    );

    const result = await runReadOnlySubagent(
      "Try external note write",
      {
        session: {
          id: "worker-3",
          title: "Worker"
        },
        decide: async () => ({
          decision: {
            kind: "tool",
            tool: "mcp",
            input: {
              action: "call_tool",
              server_id: "notes",
              tool: "write_note",
              arguments: {
                text: "hello"
              }
            },
            note: "Trying MCP"
          }
        }),
        baseTool: genericBaseTool(baseTool),
        isCancelled: () => false,
        waitWhilePaused: async () => undefined
      }
    );

    expect(result.status).toBe("approval-cancelled");
    expect(
      baseTool.mock.calls
        .filter(([tool]) => tool === "mcp")
        .every(([, , execution]) => execution === undefined)
    ).toBe(true);
  });
});
