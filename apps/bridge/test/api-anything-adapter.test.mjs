import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMcpClientManager } from "../src/mcp-client.mjs";
import { builtinMcpServer, nodeSupported } from "../src/api-engine/upstream-adapter.mjs";
import { adapterNext, asTable } from "../src/api-engine/upstream-mcp.mjs";
import { shopSiteSpec, startApiShop } from "./fixtures/api-shop.mjs";

async function setup() {
  const shop = await startApiShop();
  const bridgeHome = await mkdtemp(path.join(os.tmpdir(), "bh-api-anything-"));
  const sitesDir = path.join(bridgeHome, "api-anything", "sites");
  await mkdir(sitesDir, { recursive: true });
  await writeFile(path.join(sitesDir, "fixture-shop.json"), JSON.stringify(shopSiteSpec(shop.origin)));
  const configPath = path.join(bridgeHome, "mcp-servers.json");
  await writeFile(configPath, JSON.stringify({ mcpServers: { "api-anything": { builtin: "api-anything" } } }));
  const env = {
    ...process.env,
    BROWSERHARNESS_BRIDGE_HOME: bridgeHome,
    BROWSERHARNESS_API_ANYTHING_MIN_INTERVAL_MS: "0"
  };
  const manager = createMcpClientManager({ configPath, env });
  return {
    shop,
    manager,
    async close() {
      await manager.closeAll();
      await shop.close();
      await rm(bridgeHome, { recursive: true, force: true });
    }
  };
}

const parsed = (call) => JSON.parse(call.result.content[0].text);

test("built-in api-anything server is the Bridge's own command and needs a supported Node", () => {
  const server = builtinMcpServer("api-anything", { BROWSERHARNESS_BRIDGE_HOME: "/tmp/bh" });
  assert.equal(server.command, process.execPath);
  assert.equal(server.args.at(-1), "api-anything-mcp");
  assert.equal(server.env.API_ANYTHING_HOME, path.join("/tmp/bh", "api-anything"));
  assert.equal(nodeSupported("18.19.0"), false);
  assert.equal(nodeSupported("20.0.0"), true);
  assert.throws(() => builtinMcpServer("something-else"), /Unknown built-in/);
});

test("api-anything adapter starts over stdio, discovers four tools and lists sites", async () => {
  const ctx = await setup();
  try {
    const [server] = await ctx.manager.listServers();
    assert.equal(server.id, "api-anything");
    assert.equal(server.builtin, "api-anything");

    const listed = await ctx.manager.listTools("api-anything");
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["call_operation", "list_operations", "list_sites", "login"]);
    const byName = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.call_operation.annotations.readOnlyHint, true);
    assert.equal(byName.list_sites.annotations.readOnlyHint, true);
    // login changes the adapter's session: the trust policy asks first.
    assert.notEqual(byName.login.annotations.readOnlyHint, true);
    assert.equal(ctx.manager.diagnostics("api-anything").state, "connected");

    const sites = parsed(await ctx.manager.callTool("api-anything", "list_sites"));
    const names = sites.map((site) => site.name);
    assert.ok(names.includes("fixture-shop"));
    assert.ok(names.includes("hacker-news"), "bundled upstream specs are seeded");
    assert.equal(sites.find((site) => site.name === "fixture-shop").operations, 2, "the write is hidden");

    const ops = parsed(await ctx.manager.callTool("api-anything", "list_operations", { site: "fixture-shop" }));
    assert.deepEqual(ops.operations.map((op) => op.name), ["search", "account"]);
  } finally {
    await ctx.close();
  }
});

test("api-anything adapter executes a read operation with a structured, bounded result", async () => {
  const ctx = await setup();
  try {
    const call = await ctx.manager.callTool("api-anything", "call_operation", {
      site: "fixture-shop",
      op: "search",
      args: { q: "monitors" }
    });
    const result = parsed(call);
    assert.equal(call.result.isError, undefined);
    assert.equal(result.ok, true);
    assert.equal(result.class, "ok");
    assert.equal(result.tier, 1);
    assert.deepEqual(result.data, {
      columns: ["title", "price"],
      rows: [
        ["27 inch monitor", 249],
        ["34 inch ultrawide monitor", 499]
      ]
    });
    const sent = ctx.shop.state.requests.find((request) => request.path === "/api/search");
    assert.equal(sent.search, "?q=monitors&page=1&lang=en");
  } finally {
    await ctx.close();
  }
});

test("api-anything adapter returns input, auth and refused classes with next steps", async () => {
  const ctx = await setup();
  try {
    const unknownArg = parsed(
      await ctx.manager.callTool("api-anything", "call_operation", { site: "fixture-shop", op: "search", args: { query: "x" } })
    );
    assert.equal(unknownArg.ok, false);
    assert.equal(unknownArg.class, "input");
    assert.match(unknownArg.next, /list_operations/);

    const missing = parsed(await ctx.manager.callTool("api-anything", "call_operation", { site: "fixture-shop", op: "search", args: {} }));
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /missing required param "q"/);

    const unknownSite = await ctx.manager.callTool("api-anything", "list_operations", { site: "nope" });
    assert.equal(unknownSite.result.isError, true);
    assert.equal(parsed(unknownSite).next, "list_sites");

    const auth = parsed(await ctx.manager.callTool("api-anything", "call_operation", { site: "fixture-shop", op: "account" }));
    assert.equal(auth.ok, false);
    assert.equal(auth.class, "auth");
    assert.match(auth.next, /browserharness-bridge api-anything login fixture-shop/);

    const write = parsed(
      await ctx.manager.callTool("api-anything", "call_operation", { site: "fixture-shop", op: "addToCart", args: { id: "l1" } })
    );
    assert.equal(write.ok, false);
    assert.equal(write.class, "refused");
    assert.equal(ctx.shop.state.writes, 0, "the write never reached the site");

    // login without a person's terminal import is refused, and needs approval first.
    await assert.rejects(ctx.manager.callTool("api-anything", "login", { site: "fixture-shop" }), /MCP_APPROVAL_REQUIRED/);
    const login = parsed(
      await ctx.manager.callTool("api-anything", "login", { site: "fixture-shop" }, { allowMutating: true })
    );
    assert.equal(login.ok, false);
    assert.match(login.next, /browserharness-bridge api-anything login fixture-shop/);
    assert.ok(ctx.manager.diagnostics("api-anything").call_errors >= 4);
  } finally {
    await ctx.close();
  }
});

test("api-anything adapter process exit is reported and the next call restarts it", async () => {
  const ctx = await setup();
  try {
    await ctx.manager.listTools("api-anything");
    const { pid } = ctx.manager.diagnostics("api-anything");
    assert.ok(pid > 0);
    process.kill(pid, "SIGKILL");
    for (let i = 0; i < 50 && ctx.manager.diagnostics("api-anything").state !== "exited"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const exited = ctx.manager.diagnostics("api-anything");
    assert.equal(exited.state, "exited");
    assert.equal(exited.exits, 1);
    const [listed] = await ctx.manager.listServers();
    assert.equal(listed.connected, false);
    assert.equal(listed.diagnostics.state, "exited");

    const again = parsed(await ctx.manager.callTool("api-anything", "list_sites"));
    assert.ok(Array.isArray(again));
    const restarted = ctx.manager.diagnostics("api-anything");
    assert.equal(restarted.state, "connected");
    assert.equal(restarted.starts, 2);
  } finally {
    await ctx.close();
  }
});

test("a server that cannot start is reported as a startup failure", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bh-mcp-broken-"));
  const configPath = path.join(dir, "mcp-servers.json");
  await writeFile(
    configPath,
    JSON.stringify({ mcpServers: { broken: { command: process.execPath, args: [path.join(dir, "missing.mjs")] } } })
  );
  const manager = createMcpClientManager({ configPath });
  try {
    await assert.rejects(manager.listTools("broken"), /MCP_SERVER_START_FAILED/);
    const health = manager.diagnostics("broken");
    assert.equal(health.state, "failed");
    assert.equal(health.startup_failures, 1);
  } finally {
    await manager.closeAll();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unsupported Node marks the adapter unavailable without starting it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bh-mcp-node-"));
  const configPath = path.join(dir, "mcp-servers.json");
  await writeFile(configPath, JSON.stringify({ mcpServers: { "api-anything": { builtin: "api-anything" } } }));
  const manager = createMcpClientManager({
    configPath,
    loadConfig: async () => [
      {
        id: "api-anything",
        label: "API Anything",
        enabled: true,
        transport: "stdio",
        command: process.execPath,
        args: [],
        env: {},
        builtin: "api-anything",
        unavailable: "API_ANYTHING_NODE_UNSUPPORTED: test"
      }
    ]
  });
  try {
    await assert.rejects(manager.listTools("api-anything"), /API_ANYTHING_NODE_UNSUPPORTED/);
    const [server] = await manager.listServers();
    assert.equal(server.diagnostics.state, "unavailable");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("adapter helpers keep MCP results compact and point at BrowserHarness commands", () => {
  assert.deepEqual(asTable([{ a: 1 }, { a: 2, b: 3 }]), { columns: ["a", "b"], rows: [[1, null], [2, 3]] });
  assert.deepEqual(asTable([{ a: 1 }]), [{ a: 1 }]);
  assert.equal(
    adapterNext("ask the user to run: api-anything login x; then retry once"),
    "ask the person to run in a terminal: browserharness-bridge api-anything login x; then retry once"
  );
  assert.match(adapterNext("api-anything heal x op; if that fails"), /site_skill learn_api/);
});

test("the paired extension discovers and calls the adapter through the existing Bridge MCP path", async () => {
  const { createBridgeServer, BRIDGE_PROTOCOL_VERSION } = await import("../src/core.mjs");
  const { WebSocket } = await import("ws");
  const ctx = await setup();
  const bridge = createBridgeServer({ host: "127.0.0.1", port: 0, token: "test-token", mcpManager: ctx.manager });
  const { port } = await bridge.listen();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=test-token`);
  const next = (predicate) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 20_000);
      ws.on("message", function onMessage(raw) {
        const message = JSON.parse(raw.toString());
        if (!predicate(message)) return;
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(message);
      });
    });
  try {
    await new Promise((resolve) => ws.once("open", resolve));
    const ack = next((message) => message.type === "hello_ack");
    ws.send(JSON.stringify({ type: "hello", protocol_version: BRIDGE_PROTOCOL_VERSION, extension_id: "a".repeat(32) }));
    await ack;

    const tools = next((message) => message.id === "tools");
    ws.send(JSON.stringify({ type: "mcp_request", id: "tools", action: "list_tools", args: { server_id: "api-anything" } }));
    const listed = await tools;
    assert.equal(listed.ok, true);
    assert.equal(listed.data.tools.length, 4);

    const called = next((message) => message.id === "call");
    ws.send(
      JSON.stringify({
        type: "mcp_request",
        id: "call",
        action: "call_tool",
        approved: false,
        args: { server_id: "api-anything", tool: "call_operation", arguments: { site: "fixture-shop", op: "search", args: { q: "tablets" } } }
      })
    );
    const result = await called;
    assert.equal(result.ok, true, "a read-only tool needs no approval");
    const body = JSON.parse(result.data.result.content[0].text);
    assert.deepEqual(body.data, [{ title: "Slate tablet", price: 329 }]);

    const status = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
    assert.equal(status.mcp_server_health["api-anything"].state, "connected");
    assert.equal(status.mcp_server_health["api-anything"].calls, 1);
  } finally {
    ws.close();
    await bridge.close();
    await ctx.close();
  }
});

test("bundled upstream specs are seeded without overwriting a healed or edited spec", async () => {
  const { seedBundledSites } = await import("../src/api-engine/upstream-mcp.mjs");
  const { readFile } = await import("node:fs/promises");
  const home = await mkdtemp(path.join(os.tmpdir(), "bh-seed-"));
  const env = { API_ANYTHING_HOME: home };
  try {
    const dir = await seedBundledSites(env);
    const original = await readFile(path.join(dir, "hacker-news.json"), "utf8");
    await writeFile(path.join(dir, "hacker-news.json"), original.replace("Hacker News", "Hacker News (healed)"));
    await seedBundledSites(env);
    assert.match(await readFile(path.join(dir, "hacker-news.json"), "utf8"), /healed/);
    assert.equal(await readFile(path.join(dir, "x.json"), "utf8"), (await import("../vendor/api-anything/sites-index.js")).BUNDLED_SITES["x.json"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("vendored API Anything files match their recorded hashes", async () => {
  const { spawnSync } = await import("node:child_process");
  const script = new URL("../../../scripts/vendor-api-anything.mjs", import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname, "--check"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fe5cca7: \d+ files match/);
});
