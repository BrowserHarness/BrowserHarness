import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export const DEFAULT_MCP_SERVERS_FILE = path.join(
  os.homedir(),
  ".browserharness-bridge",
  "mcp-servers.json"
);

const SERVER_ID = /^[A-Za-z0-9._-]{1,80}$/;

function interpolateEnv(value, env = process.env) {
  return String(value).replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_match, name) => {
      const resolved = env[name];
      if (resolved === undefined) {
        throw new Error(
          `Environment variable ${name} is required by MCP server config`
        );
      }
      return resolved;
    }
  );
}

function normalizeServer(id, raw, env = process.env) {
  if (!SERVER_ID.test(id)) {
    throw new Error(
      `Invalid MCP server id: ${id}`
    );
  }
  if (!raw || typeof raw !== "object") {
    throw new Error(
      `MCP server ${id} config must be an object`
    );
  }
  if (
    typeof raw.command !== "string" ||
    !raw.command.trim()
  ) {
    throw new Error(
      `MCP server ${id} requires a stdio command`
    );
  }
  if (
    raw.args !== undefined &&
    (!Array.isArray(raw.args) ||
      raw.args.some((item) => typeof item !== "string"))
  ) {
    throw new Error(
      `MCP server ${id} args must be an array of strings`
    );
  }
  if (
    raw.env !== undefined &&
    (!raw.env ||
      typeof raw.env !== "object" ||
      Array.isArray(raw.env) ||
      Object.values(raw.env).some(
        (value) => typeof value !== "string"
      ))
  ) {
    throw new Error(
      `MCP server ${id} env must be a string map`
    );
  }
  if (
    raw.cwd !== undefined &&
    typeof raw.cwd !== "string"
  ) {
    throw new Error(
      `MCP server ${id} cwd must be a string`
    );
  }

  const customEnv = Object.fromEntries(
    Object.entries(raw.env || {}).map(([key, value]) => [
      key,
      interpolateEnv(value, env)
    ])
  );

  return {
    id,
    label:
      typeof raw.label === "string" && raw.label.trim()
        ? raw.label.trim().slice(0, 160)
        : id,
    enabled: raw.enabled !== false,
    transport: "stdio",
    command: raw.command.trim(),
    args: (raw.args || []).map(String),
    ...(raw.cwd?.trim()
      ? { cwd: raw.cwd.trim() }
      : {}),
    env: customEnv
  };
}

export function normalizeMcpServersConfig(
  raw,
  env = process.env
) {
  if (!raw || typeof raw !== "object") {
    throw new Error("MCP servers config must be an object");
  }

  const source =
    raw.mcpServers &&
    typeof raw.mcpServers === "object" &&
    !Array.isArray(raw.mcpServers)
      ? raw.mcpServers
      : raw.servers &&
          typeof raw.servers === "object" &&
          !Array.isArray(raw.servers)
        ? raw.servers
        : {};

  return Object.entries(source).map(([id, config]) =>
    normalizeServer(id, config, env)
  );
}

export async function loadMcpServersConfig(
  filePath = DEFAULT_MCP_SERVERS_FILE,
  env = process.env
) {
  try {
    const raw = JSON.parse(
      await readFile(filePath, "utf8")
    );
    return normalizeMcpServersConfig(raw, env);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
}

function configFingerprint(server) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        command: server.command,
        args: server.args,
        cwd: server.cwd || "",
        env: server.env
      })
    )
    .digest("hex");
}

export function mcpToolRequiresApproval(tool) {
  const annotations =
    tool?.annotations &&
    typeof tool.annotations === "object"
      ? tool.annotations
      : {};

  return !(
    annotations.readOnlyHint === true &&
    annotations.destructiveHint !== true
  );
}

function boundedToolResult(result, maxChars = 100_000) {
  let serialized;
  try {
    serialized = JSON.stringify(result);
  } catch {
    return {
      content: [
        {
          type: "text",
          text:
            "External MCP tool returned a non-serializable result."
        }
      ],
      isError: true,
      _browserharness: {
        truncated: false,
        serialization_failed: true
      }
    };
  }

  if (serialized.length <= maxChars) {
    return result;
  }

  return {
    content: [
      {
        type: "text",
        text:
          `BrowserHarness truncated an oversized external MCP result. Original JSON length: ${serialized.length}.\n` +
          serialized.slice(0, maxChars)
      }
    ],
    ...(result?.isError === true ? { isError: true } : {}),
    _browserharness: {
      truncated: true,
      original_chars: serialized.length,
      retained_chars: maxChars
    }
  };
}

function publicServer(server, connected = false) {
  return {
    id: server.id,
    label: server.label,
    enabled: server.enabled,
    transport: server.transport,
    connected,
    env_keys: Object.keys(server.env).sort()
  };
}

export function createMcpClientManager({
  configPath = DEFAULT_MCP_SERVERS_FILE,
  env = process.env,
  loadConfig = () =>
    loadMcpServersConfig(configPath, env)
} = {}) {
  const connections = new Map();

  async function configs() {
    const servers = await loadConfig();
    return new Map(
      servers.map((server) => [server.id, server])
    );
  }

  async function closeEntry(id) {
    const existing = connections.get(id);
    if (!existing) return;
    connections.delete(id);
    await existing.client.close().catch(
      () => undefined
    );
  }

  async function connectionFor(id) {
    const available = await configs();
    const server = available.get(id);
    if (!server) {
      throw new Error(
        `MCP_SERVER_NOT_FOUND: ${id}`
      );
    }
    if (!server.enabled) {
      throw new Error(
        `MCP_SERVER_DISABLED: ${id}`
      );
    }

    const fingerprint = configFingerprint(server);
    const existing = connections.get(id);
    if (
      existing &&
      existing.fingerprint === fingerprint
    ) {
      return existing;
    }
    if (existing) {
      await closeEntry(id);
    }

    const client = new Client(
      {
        name: "browserharness-bridge",
        version: "0.3.0"
      },
      {
        versionNegotiation: {
          mode: "auto"
        }
      }
    );
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      ...(server.cwd ? { cwd: server.cwd } : {}),
      ...(Object.keys(server.env).length
        ? { env: server.env }
        : {})
    });

    await client.connect(transport);
    const entry = {
      client,
      transport,
      fingerprint,
      server
    };
    connections.set(id, entry);
    return entry;
  }

  return {
    configPath,

    async listServers() {
      const available = await configs();
      return [...available.values()].map((server) =>
        publicServer(
          server,
          connections.has(server.id)
        )
      );
    },

    async listTools(id) {
      const entry = await connectionFor(id);
      const result = await entry.client.listTools();
      return {
        server: publicServer(entry.server, true),
        tools: result.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description
            ? { description: tool.description }
            : {}),
          ...(tool.inputSchema
            ? { inputSchema: tool.inputSchema }
            : {}),
          ...(tool.annotations
            ? { annotations: tool.annotations }
            : {})
        }))
      };
    },

    async callTool(
      id,
      name,
      args = {},
      { allowMutating = false } = {}
    ) {
      if (
        typeof name !== "string" ||
        !name.trim()
      ) {
        throw new Error("MCP_TOOL_NAME_REQUIRED");
      }
      if (
        !args ||
        typeof args !== "object" ||
        Array.isArray(args)
      ) {
        throw new Error(
          "MCP_TOOL_ARGUMENTS_INVALID"
        );
      }

      const entry = await connectionFor(id);
      const listed = await entry.client.listTools();
      const tool = listed.tools.find(
        (item) => item.name === name
      );
      if (!tool) {
        throw new Error(
          `MCP_TOOL_NOT_FOUND: ${id}/${name}`
        );
      }

      if (
        mcpToolRequiresApproval(tool) &&
        !allowMutating
      ) {
        throw new Error(
          `MCP_APPROVAL_REQUIRED: ${id}/${name}`
        );
      }

      const result = await entry.client.callTool({
        name,
        arguments: args
      });

      return {
        server_id: id,
        tool: name,
        annotations: tool.annotations || {},
        result: boundedToolResult(result)
      };
    },

    async close(id) {
      await closeEntry(id);
    },

    async closeAll() {
      const ids = [...connections.keys()];
      await Promise.all(
        ids.map((id) => closeEntry(id))
      );
    }
  };
}
