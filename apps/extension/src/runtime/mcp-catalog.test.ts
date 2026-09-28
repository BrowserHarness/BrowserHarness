import { describe, expect, it, vi } from "vitest";
import { discoverMcpCatalog } from "./mcp-catalog";

describe("bounded MCP planner catalog", () => {
  it("excludes blocked servers and ranks relevant tools first", async () => {
    const run = vi.fn(
      async (input: Record<string, unknown>) => {
        if (input.action === "servers") {
          return {
            ok: true,
            data: {
              servers: [
                {
                  id: "notes",
                  label: "Notes",
                  enabled: true
                },
                {
                  id: "payments",
                  label: "Payments",
                  enabled: true
                }
              ]
            }
          };
        }

        if (input.server_id === "notes") {
          return {
            ok: true,
            data: {
              tools: [
                {
                  name: "search_notes",
                  description: "Search saved notes",
                  annotations: {
                    readOnlyHint: true,
                    destructiveHint: false
                  }
                },
                {
                  name: "create_note",
                  description: "Create a new note",
                  annotations: {
                    readOnlyHint: false,
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
            tools: [
              {
                name: "charge_card",
                description: "Charge a payment method"
              }
            ]
          }
        };
      }
    );

    const catalog = await discoverMcpCatalog(
      "find my saved note",
      run,
      async (serverId) =>
        serverId === "payments"
          ? "blocked"
          : "allow-read-only"
    );

    expect(catalog.servers_considered).toBe(2);
    expect(catalog.tools.map((tool) => tool.name)).toEqual([
      "search_notes",
      "create_note"
    ]);
    expect(catalog.tools[0]).toMatchObject({
      read_only: true,
      requires_approval: false
    });
    expect(catalog.tools[1]).toMatchObject({
      read_only: false,
      requires_approval: true
    });
    expect(
      catalog.tools.some(
        (tool) => tool.server_id === "payments"
      )
    ).toBe(false);
  });

  it("ask-all marks even read-only tools as approval-required", async () => {
    const run = vi.fn(async (input: Record<string, unknown>) =>
      input.action === "servers"
        ? {
            ok: true,
            data: {
              servers: [
                {
                  id: "docs",
                  label: "Docs",
                  enabled: true
                }
              ]
            }
          }
        : {
            ok: true,
            data: {
              tools: [
                {
                  name: "read_doc",
                  annotations: {
                    readOnlyHint: true,
                    destructiveHint: false
                  }
                }
              ]
            }
          }
    );

    const catalog = await discoverMcpCatalog(
      "read doc",
      run,
      async () => "ask-all"
    );

    expect(catalog.tools[0]).toMatchObject({
      name: "read_doc",
      read_only: true,
      requires_approval: true,
      trust_mode: "ask-all"
    });
  });

  it("returns an empty catalog when Bridge MCP discovery is unavailable", async () => {
    const catalog = await discoverMcpCatalog(
      "anything",
      async () => ({
        ok: false,
        error: {
          code: "BRIDGE_DISCONNECTED",
          message: "offline"
        }
      }),
      async () => "allow-read-only"
    );

    expect(catalog).toEqual({
      servers_considered: 0,
      tools: []
    });
  });
});
