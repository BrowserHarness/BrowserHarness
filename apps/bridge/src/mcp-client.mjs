import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { builtinMcpServer } from "./api-engine/upstream-adapter.mjs";

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
  // A server the Bridge itself ships ({"builtin": "api-anything"}): the Bridge
  // owns its command line, so a config file cannot point it elsewhere.
  if (raw.builtin !== undefined) {
    const builtin = builtinMcpServer(raw.builtin, env);
    raw = {
      ...builtin,
      label: typeof raw.label === "string" && raw.label.trim() ? raw.label : builtin.label,
      enabled: raw.enabled,
      env: { ...builtin.env }
    };
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
    ...(raw.builtin ? { builtin: raw.builtin } : {}),
    ...(raw.unavailable ? { unavailable: raw.unavailable } : {}),
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

function publicServer(server, connected = false, health) {
  return {
    id: server.id,
    label: server.label,
    enabled: server.enabled,
    transport: server.transport,
    connected,
    ...(server.builtin ? { builtin: server.builtin } : {}),
    env_keys: Object.keys(server.env).sort(),
    ...(health ? { diagnostics: { ...health } } : {})
  };
}

/** Error messages that may echo a server's output are bounded before they reach status pages. */
function shortError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0].slice(0, 300);
}

export function createMcpClientManager({
  configPath = DEFAULT_MCP_SERVERS_FILE,
  env = process.env,
  loadConfig = () =>
    loadMcpServersConfig(configPath, env)
} = {}) {
  const connections = new Map();
  // Per-server health: availability, startup failures, process exits and
  // operation errors, shown by `mcp-servers`, GET /status and Settings.
  const health = new Map();
  function healthFor(id) {
    if (!health.has(id)) {
      health.set(id, {
        state: "idle",
        starts: 0,
        startup_failures: 0,
        exits: 0,
        calls: 0,
        call_errors: 0
      });
    }
    return health.get(id);
  }
  function note(id, patch) {
    Object.assign(healthFor(id), patch, { updated_at: new Date().toISOString() });
  }

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
    if (server.unavailable) {
      note(id, { state: "unavailable", last_error: server.unavailable });
      throw new Error(server.unavailable);
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

    const record = healthFor(id);
    record.starts += 1;
    note(id, { state: "starting" });
    try {
      await client.connect(transport);
    } catch (error) {
      record.startup_failures += 1;
      note(id, {
        state: "failed",
        last_error: `MCP_SERVER_START_FAILED: ${shortError(error)}`
      });
      await client.close().catch(() => undefined);
      throw new Error(`MCP_SERVER_START_FAILED: ${id}: ${shortError(error)}`);
    }
    const entry = {
      client,
      transport,
      fingerprint,
      server
    };
    connections.set(id, entry);
    note(id, { state: "connected", connected_at: new Date().toISOString(), pid: transport.pid ?? undefined });
    // The process went away (crash, exit, closed pipe): forget the
    // connection so the next call starts it again, and say so.
    client.onclose = () => {
      if (connections.get(id) === entry) {
        connections.delete(id);
        healthFor(id).exits += 1;
        note(id, { state: "exited", exited_at: new Date().toISOString(), pid: undefined });
      }
    };
    return entry;
  }

  return {
    configPath,

    async listServers() {
      const available = await configs();
      return [...available.values()].map((server) =>
        publicServer(
          server,
          connections.has(server.id),
          health.get(server.id) ||
            (server.unavailable
              ? { state: "unavailable", last_error: server.unavailable }
              : undefined)
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

      const record = healthFor(id);
      record.calls += 1;
      let result;
      try {
        result = await entry.client.callTool({
          name,
          arguments: args
        });
      } catch (error) {
        record.call_errors += 1;
        note(id, { last_call_error: `${name}: ${shortError(error)}` });
        throw new Error(`MCP_TOOL_CALL_FAILED: ${id}/${name}: ${shortError(error)}`);
      }
      if (result?.isError === true) {
        record.call_errors += 1;
        note(id, { last_call_error: `${name}: tool returned an error result` });
      }

      return {
        server_id: id,
        tool: name,
        annotations: tool.annotations || {},
        result: boundedToolResult(result)
      };
    },

    diagnostics(id) {
      return id
        ? { ...(health.get(id) || { state: "idle" }) }
        : Object.fromEntries([...health].map(([key, value]) => [key, { ...value }]));
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
