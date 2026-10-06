import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import {
  BRIDGE_PROTOCOL_VERSION,
  createBridgeServer
} from "../src/core.mjs";
import {
  createLlmAdapterManager,
  LLM_ADAPTER_IDS
} from "../src/llm-adapters.mjs";

async function fakeCli(body) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bh-fake-cli-"));
  const file = path.join(dir, "fake-cli");
  if (process.platform === "win32") {
    // The same shape as the .cmd script npm writes for an installed CLI.
    await writeFile(`${file}.js`, `${body}\n`);
    await writeFile(`${file}.cmd`, `@ECHO off\r\nnode  "%dp0%\\fake-cli.js" %*\r\n`);
    return `${file}.cmd`;
  }
  await writeFile(file, `#!/usr/bin/env node\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

const ECHO_CLAUDE = `
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  if (args[0] === "--version") { console.log("9.9.9 (fake)"); return; }
  console.log(JSON.stringify({
    type: "result", subtype: "success", is_error: false,
    result: JSON.stringify({ args, stdin: input, cwd: process.cwd() })
  }));
});`;

test("claude adapter runs the CLI with tools disabled and prompt on stdin", async () => {
  const cmd = await fakeCli(ECHO_CLAUDE);
  const manager = createLlmAdapterManager({
    env: { ...process.env, BROWSERHARNESS_CLAUDE_COMMAND: cmd }
  });
  const status = await manager.status("claude_cli");
  assert.equal(status.installed, true);
  assert.match(status.version, /9\.9\.9/);

  const out = await manager.complete({
    adapter: "claude_cli",
    model: "sonnet",
    system: 'be brief\n"and" kind & 100% honest',
    prompt: "hello there"
  });
  const echoed = JSON.parse(out.text);
  assert.equal(echoed.stdin, "hello there");
  assert.deepEqual(
    echoed.args.slice(0, 5),
    ["-p", "--output-format", "json", "--tools", ""]
  );
  assert.ok(echoed.args.includes("--no-session-persistence"));
  assert.equal(echoed.args[echoed.args.indexOf("--system-prompt") + 1], 'be brief\n"and" kind & 100% honest');
  assert.equal(echoed.args[echoed.args.indexOf("--model") + 1], "sonnet");
  assert.match(echoed.cwd, /browserharness-llm-/);
});

test("default model is not forwarded and models are validated", async () => {
  const cmd = await fakeCli(ECHO_CLAUDE);
  const manager = createLlmAdapterManager({
    env: { ...process.env, BROWSERHARNESS_CLAUDE_COMMAND: cmd }
  });
  const out = await manager.complete({ adapter: "claude_cli", prompt: "x" });
  assert.equal(JSON.parse(out.text).args.includes("--model"), false);
  await assert.rejects(
    manager.complete({ adapter: "claude_cli", model: "x; rm -rf /", prompt: "x" }),
    /model name is not valid/
  );
  await assert.rejects(
    manager.complete({ adapter: "bash", prompt: "x" }),
    /Unknown adapter/
  );
  assert.deepEqual(LLM_ADAPTER_IDS, ["claude_cli", "codex_cli"]);
});

test("claude adapter surfaces CLI errors and missing installs", async () => {
  const failing = await fakeCli(`
let i=""; process.stdin.on("data",c=>i+=c); process.stdin.on("end",()=>{
console.log(JSON.stringify({type:"result",is_error:true,result:"Not logged in"}));});`);
  const manager = createLlmAdapterManager({
    env: { ...process.env, BROWSERHARNESS_CLAUDE_COMMAND: failing }
  });
  await assert.rejects(
    manager.complete({ adapter: "claude_cli", prompt: "x" }),
    /Not logged in/
  );

  const missing = createLlmAdapterManager({
    env: { ...process.env, BROWSERHARNESS_CLAUDE_COMMAND: "/nonexistent/claude-xyz" }
  });
  const status = await missing.status("claude_cli");
  assert.equal(status.installed, false);
  await assert.rejects(
    missing.complete({ adapter: "claude_cli", prompt: "x" }),
    /not installed/
  );
});

test("adapter times out and kills a hung CLI", async () => {
  const hang = await fakeCli(`setInterval(()=>{},1000);`);
  const manager = createLlmAdapterManager({
    env: { ...process.env, BROWSERHARNESS_CLAUDE_COMMAND: hang }
  });
  await assert.rejects(
    manager.complete({ adapter: "claude_cli", prompt: "x", timeoutMs: 5_000 }),
    /did not answer/
  );
});

test("codex adapter reads the last-message file and folds the system prompt in", async () => {
  const cmd = await fakeCli(`
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  if (args[0] === "--version") { console.log("codex 0.0.0 fake"); return; }
  const out = args[args.indexOf("--output-last-message") + 1];
  fs.writeFileSync(out, JSON.stringify({ args, input }));
  console.log("progress noise");
});`);
  const manager = createLlmAdapterManager({
    env: { ...process.env, BROWSERHARNESS_CODEX_COMMAND: cmd }
  });
  const out = await manager.complete({
    adapter: "codex_cli",
    model: "gpt-5",
    system: "SYS",
    prompt: "USER"
  });
  const echoed = JSON.parse(out.text);
  assert.ok(echoed.input.startsWith("SYS"));
  assert.ok(echoed.input.endsWith("USER"));
  assert.deepEqual(echoed.args.slice(0, 2), ["exec", "--skip-git-repo-check"]);
  assert.equal(echoed.args[echoed.args.indexOf("--sandbox") + 1], "read-only");
  assert.equal(echoed.args[echoed.args.indexOf("-m") + 1], "gpt-5");
  assert.equal(echoed.args.at(-1), "-");
});

test("Bridge relays llm_request only from the paired extension", async () => {
  const cmd = await fakeCli(ECHO_CLAUDE);
  const token = "test-token";
  const bridge = createBridgeServer({
    host: "127.0.0.1",
    port: 0,
    token,
    llmManager: createLlmAdapterManager({
      env: { ...process.env, BROWSERHARNESS_CLAUDE_COMMAND: cmd }
    })
  });
  const address = await bridge.listen();
  const open = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws?token=${token}`);
    await new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    return ws;
  };
  const next = (ws, type) =>
    new Promise((resolve) => {
      ws.on("message", function onMessage(raw) {
        const message = JSON.parse(raw.toString());
        if (message.type !== type) return;
        ws.off("message", onMessage);
        resolve(message);
      });
    });
  try {
    const ext = await open();
    ext.send(JSON.stringify({ type: "hello", protocol_version: BRIDGE_PROTOCOL_VERSION, extension_id: "e", extension_version: "1" }));
    await next(ext, "hello_ack");

    const pending = next(ext, "llm_result");
    ext.send(JSON.stringify({ type: "llm_request", id: "1", action: "complete", args: { adapter: "claude_cli", prompt: "ping" } }));
    const done = await pending;
    assert.equal(done.ok, true);
    assert.equal(JSON.parse(done.data.text).stdin, "ping");

    const statusReply = next(ext, "llm_result");
    ext.send(JSON.stringify({ type: "llm_request", id: "2", action: "status", args: { adapter: "claude_cli" } }));
    assert.equal((await statusReply).data.installed, true);

    const intruder = await open();
    const denied = next(intruder, "llm_result");
    intruder.send(JSON.stringify({ type: "llm_request", id: "3", action: "complete", args: { adapter: "claude_cli", prompt: "x" } }));
    const refused = await denied;
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, "LLM_EXTENSION_REQUIRED");
    intruder.close();
    ext.close();
  } finally {
    await bridge.close();
  }
});
