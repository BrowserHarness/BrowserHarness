import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createMcpClientManager,
  loadMcpServersConfig,
  normalizeMcpServersConfig
} from "../src/mcp-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(
  HERE,
  "fixtures",
  "external-mcp-server.mjs"
);

test("normalizes common mcpServers config and interpolates environment secrets", () => {
  const servers = normalizeMcpServersConfig(
    {
      mcpServers: {
        notes: {
          command: "node",
          args: ["server.mjs"],
          env: {
            NOTES_TOKEN: "${NOTES_TOKEN}"
          }
        }
      }
    },
    {
      NOTES_TOKEN: "super-secret"
    }
  );

  assert.equal(servers.length, 1);
  assert.equal(servers[0].id, "notes");
  assert.equal(
    servers[0].env.NOTES_TOKEN,
    "super-secret"
  );
});

test("missing MCP config is an empty server registry", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "browsercrew-mcp-empty-")
  );
  try {
    const servers = await loadMcpServersConfig(
      path.join(dir, "missing.json")
    );
    assert.deepEqual(servers, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("outbound MCP client discovers and calls a real stdio server", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "browsercrew-mcp-client-")
  );
  const configPath = path.join(dir, "mcp-servers.json");

  await writeFile(
    configPath,
    JSON.stringify(
      {
        mcpServers: {
          fixture: {
            label: "Fixture MCP",
            command: process.execPath,
            args: [FIXTURE],
            env: {
              FIXTURE_SECRET: "${FIXTURE_SECRET}"
            }
          }
        }
      },
      null,
      2
    )
  );

  const manager = createMcpClientManager({
    configPath,
    env: {
      FIXTURE_SECRET: "do-not-expose"
    }
  });

  try {
    const servers = await manager.listServers();
    assert.deepEqual(servers, [
      {
        id: "fixture",
        label: "Fixture MCP",
        enabled: true,
        transport: "stdio",
        connected: false,
        env_keys: ["FIXTURE_SECRET"]
      }
    ]);
    assert.equal(
      JSON.stringify(servers).includes("do-not-expose"),
      false
    );

    const listed = await manager.listTools("fixture");
    const echo = listed.tools.find(
      (tool) => tool.name === "echo"
    );
    const writeNote = listed.tools.find(
      (tool) => tool.name === "write_note"
    );

    assert.equal(echo.annotations.readOnlyHint, true);
    assert.equal(
      writeNote.annotations.destructiveHint,
      true
    );

    const called = await manager.callTool(
      "fixture",
      "echo",
      { text: "BrowserCrew" }
    );

    assert.equal(called.server_id, "fixture");
    assert.equal(called.tool, "echo");
    assert.equal(
      called.result.content[0].text,
      "BrowserCrew"
    );
    assert.equal(
      called.annotations.readOnlyHint,
      true
    );

    await assert.rejects(
      () =>
        manager.callTool(
          "fixture",
          "write_note",
          { text: "mutating" }
        ),
      /MCP_APPROVAL_REQUIRED/
    );

    const approved = await manager.callTool(
      "fixture",
      "write_note",
      { text: "mutating" },
      { allowMutating: true }
    );
    assert.equal(
      approved.result.content[0].text,
      "saved:mutating"
    );

    const connected = await manager.listServers();
    assert.equal(connected[0].connected, true);
  } finally {
    await manager.closeAll();
    await rm(dir, { recursive: true, force: true });
  }
});

test("outbound MCP client rejects unknown tools before calling", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "browsercrew-mcp-client-")
  );
  const configPath = path.join(dir, "mcp-servers.json");

  await writeFile(
    configPath,
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [FIXTURE]
        }
      }
    })
  );

  const manager = createMcpClientManager({
    configPath
  });

  try {
    await assert.rejects(
      () =>
        manager.callTool(
          "fixture",
          "missing_tool",
          {}
        ),
      /MCP_TOOL_NOT_FOUND/
    );
  } finally {
    await manager.closeAll();
    await rm(dir, { recursive: true, force: true });
  }
});
