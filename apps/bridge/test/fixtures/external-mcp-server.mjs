import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

function createServer() {
  const server = new McpServer({
    name: "browsercrew-test-external",
    version: "1.0.0"
  });

  server.registerTool(
    "echo",
    {
      description: "Echo text for BrowserCrew MCP client tests.",
      inputSchema: z.object({
        text: z.string()
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false
      }
    },
    async ({ text }) => ({
      content: [
        {
          type: "text",
          text
        }
      ]
    })
  );

  server.registerTool(
    "write_note",
    {
      description: "Mutating test tool.",
      inputSchema: z.object({
        text: z.string()
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true
      }
    },
    async ({ text }) => ({
      content: [
        {
          type: "text",
          text: `saved:${text}`
        }
      ]
    })
  );

  return server;
}

void serveStdio(createServer);
