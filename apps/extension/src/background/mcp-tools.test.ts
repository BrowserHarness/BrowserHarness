import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import {
  externalMcpToolRequiresApproval,
  runExternalMcpTool
} from "./mcp-tools";

let trustStore: Record<string, unknown>;

beforeEach(() => {
  trustStore = {};
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          get: async (key: string) => ({
            [key]: trustStore[key]
          }),
          set: async (value: Record<string, unknown>) => {
            Object.assign(
              trustStore,
              structuredClone(value)
            );
          }
        }
      }
    }
  });
});

describe("external MCP runtime tool", () => {
  it("treats only explicitly read-only non-destructive tools as approval-free", () => {
    expect(
      externalMcpToolRequiresApproval({
        name: "read",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false
        }
      })
    ).toBe(false);

    expect(
      externalMcpToolRequiresApproval({
        name: "unknown"
      })
    ).toBe(true);

    expect(
      externalMcpToolRequiresApproval({
        name: "delete",
        annotations: {
          readOnlyHint: true,
          destructiveHint: true
        }
      })
    ).toBe(true);
  });

  it("discovers immediately before an approval-free read-only call", async () => {
    const requester = vi.fn(
      async (action: string) => {
        if (action === "list_tools") {
          return {
            ok: true,
            data: {
              tools: [
                {
                  name: "search",
                  annotations: {
                    readOnlyHint: true,
                    destructiveHint: false
                  }
                }
              ]
            }
          };
        }
        return {
          ok: true,
          data: {
            server_id: "notes",
            tool: "search",
            result: {
              content: [
                {
                  type: "text",
                  text: "found"
                }
              ]
            }
          }
        };
      }
    );

    const result = await runExternalMcpTool(
      {
        action: "call_tool",
        server_id: "notes",
        tool: "search",
        arguments: {
          query: "BrowserHarness"
        }
      },
      {},
      requester
    );

    expect(result.ok).toBe(true);
    expect(requester).toHaveBeenNthCalledWith(
      1,
      "list_tools",
      { server_id: "notes" }
    );
    expect(requester).toHaveBeenNthCalledWith(
      2,
      "call_tool",
      {
        server_id: "notes",
        tool: "search",
        arguments: {
          query: "BrowserHarness"
        }
      },
      false
    );
  });

  it("blocks mutating or unannotated tools until BrowserHarness approval", async () => {
    const requester = vi.fn(async () => ({
      ok: true,
      data: {
        tools: [
          {
            name: "write_note",
            annotations: {
              readOnlyHint: false,
              destructiveHint: true
            }
          }
        ]
      }
    }));

    const result = await runExternalMcpTool(
      {
        action: "call_tool",
        server_id: "notes",
        tool: "write_note",
        arguments: {
          text: "hello"
        }
      },
      {},
      requester
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "APPROVAL_REQUIRED"
      }
    });
    expect(requester).toHaveBeenCalledTimes(1);
  });

  it("blocks every call from a blocked MCP server", async () => {
    const requester = vi.fn(async () => ({
      ok: true,
      data: {
        tools: [
          {
            name: "search",
            annotations: {
              readOnlyHint: true,
              destructiveHint: false
            }
          }
        ]
      }
    }));

    const result = await runExternalMcpTool(
      {
        action: "call_tool",
        server_id: "notes",
        tool: "search",
        arguments: {}
      },
      {},
      requester,
      async () => "blocked"
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "MCP_SERVER_BLOCKED"
      }
    });
    expect(requester).not.toHaveBeenCalled();
  });

  it("ask-all requires approval even for a read-only tool", async () => {
    const requester = vi.fn(async () => ({
      ok: true,
      data: {
        tools: [
          {
            name: "search",
            annotations: {
              readOnlyHint: true,
              destructiveHint: false
            }
          }
        ]
      }
    }));

    const result = await runExternalMcpTool(
      {
        action: "call_tool",
        server_id: "notes",
        tool: "search",
        arguments: {}
      },
      {},
      requester,
      async () => "ask-all"
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "APPROVAL_REQUIRED"
      }
    });
    expect(requester).toHaveBeenCalledTimes(1);
  });

  it("executes a mutating tool only on an approved retry", async () => {
    const requester = vi.fn(
      async (action: string) => {
        if (action === "list_tools") {
          return {
            ok: true,
            data: {
              tools: [
                {
                  name: "write_note",
                  annotations: {
                    readOnlyHint: false,
                    destructiveHint: true
                  }
                }
              ]
            }
          };
        }
        return {
          ok: true,
          data: {
            result: {
              content: [
                {
                  type: "text",
                  text: "saved"
                }
              ]
            }
          }
        };
      }
    );

    const result = await runExternalMcpTool(
      {
        action: "call_tool",
        server_id: "notes",
        tool: "write_note",
        arguments: {
          text: "hello"
        }
      },
      { approvalGranted: true },
      requester
    );

    expect(result.ok).toBe(true);
    expect(requester).toHaveBeenNthCalledWith(
      2,
      "call_tool",
      {
        server_id: "notes",
        tool: "write_note",
        arguments: {
          text: "hello"
        }
      },
      true
    );
  });
});
