// The API Anything compatibility adapter as a built-in MCP server.
// It is a stepping stone: the native engine (learn.mjs, dispatcher.mjs) is what
// BrowserHarness Site Skills use. This file stays free of vendored imports, so
// loading the MCP client never loads upstream code.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const API_ANYTHING_SERVER_ID = "api-anything";
export const API_ANYTHING_COMMIT = "fe5cca70fe145634e49a1c9ba1f3e8250b291bea";
export const API_ANYTHING_MIN_NODE = [20, 0];
const BUNDLED = typeof __BROWSERHARNESS_BUNDLED__ !== "undefined";

export function bridgeHome(env = process.env) {
  return env.BROWSERHARNESS_BRIDGE_HOME || path.join(os.homedir(), ".browserharness-bridge");
}

/** The adapter's own data folder; never the person's own ~/.api-anything. */
export function apiAnythingHome(env = process.env) {
  return path.join(bridgeHome(env), "api-anything");
}

/** The Bridge CLI that hosts the adapter: the single-file build, or src/cli.mjs. */
export function bridgeCliPath() {
  return BUNDLED
    ? fileURLToPath(import.meta.url)
    : fileURLToPath(new URL("../cli.mjs", import.meta.url));
}

export function nodeSupported(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  const [needMajor, needMinor] = API_ANYTHING_MIN_NODE;
  return major > needMajor || (major === needMajor && minor >= needMinor);
}

/**
 * The stdio command for a built-in server. Unknown names fail; an unsupported
 * Node marks the server unavailable instead of starting a process that breaks.
 */
export function builtinMcpServer(name, env = process.env) {
  if (name !== API_ANYTHING_SERVER_ID) {
    throw new Error(`Unknown built-in MCP server: ${String(name)}`);
  }
  const serverEnv = {
    API_ANYTHING_HOME: apiAnythingHome(env),
    BROWSERHARNESS_BRIDGE_HOME: bridgeHome(env)
  };
  for (const key of ["BROWSERHARNESS_API_ANYTHING_MAX_TIER", "BROWSERHARNESS_API_ANYTHING_MIN_INTERVAL_MS", "HOME", "PATH"]) {
    if (typeof env[key] === "string") serverEnv[key] = env[key];
  }
  return {
    builtin: name,
    label: `API Anything ${API_ANYTHING_COMMIT.slice(0, 7)} (read-only compatibility)`,
    command: process.execPath,
    args: [bridgeCliPath(), "api-anything-mcp"],
    env: serverEnv,
    ...(nodeSupported()
      ? {}
      : {
          unavailable: `API_ANYTHING_NODE_UNSUPPORTED: the API Anything adapter needs Node ${API_ANYTHING_MIN_NODE.join(".")} or newer; this Bridge runs ${process.versions.node}`
        })
  };
}
