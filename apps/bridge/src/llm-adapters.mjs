import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Subscription adapters.
 *
 * Lets a user run BrowserHarness on the ChatGPT or Claude subscription they
 * already pay for, without an API key, by driving the vendor's own official
 * command-line client that is installed and logged in on this machine. The
 * Bridge never reads, copies or forwards the vendor's login tokens; it only
 * starts the vendor's CLI as a text-in/text-out subprocess with its tools
 * disabled. The extension can pick an adapter by id and a model name, never a
 * command line: the commands below are fixed here.
 */

export const LLM_ADAPTER_IDS = ["claude_cli", "codex_cli"];

const MAX_PROMPT_CHARS = 400_000;
const MAX_OUTPUT_CHARS = 200_000;
const MAX_CONCURRENT = 2;
const DEFAULT_TIMEOUT_MS = 120_000;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/\-\[\]]{0,79}$/;

const ADAPTERS = {
  claude_cli: {
    label: "Claude subscription (Claude Code CLI)",
    command: "claude",
    env: "BROWSERHARNESS_CLAUDE_COMMAND",
    versionArgs: ["--version"],
    build({ model, system }) {
      const args = [
        "-p",
        "--output-format",
        "json",
        "--tools",
        "",
        "--no-session-persistence",
        "--disable-slash-commands",
        "--setting-sources",
        ""
      ];
      if (system) args.push("--system-prompt", system);
      if (model && model !== "default") args.push("--model", model);
      return { args };
    },
    parse(stdout) {
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw adapterError("ADAPTER_BAD_OUTPUT", "Claude CLI returned non-JSON output");
      }
      if (parsed?.is_error === true) {
        throw adapterError(
          "ADAPTER_CLI_ERROR",
          String(parsed.result || "Claude CLI reported an error").slice(0, 300)
        );
      }
      return String(parsed?.result ?? "");
    }
  },
  codex_cli: {
    label: "ChatGPT subscription (Codex CLI)",
    command: "codex",
    env: "BROWSERHARNESS_CODEX_COMMAND",
    versionArgs: ["--version"],
    build({ model, system }, { outputFile }) {
      const args = [
        "exec",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--color",
        "never",
        "--output-last-message",
        outputFile
      ];
      if (model && model !== "default") args.push("-m", model);
      args.push("-");
      return {
        args,
        // Codex exec has no separate system prompt flag: fold it into the prompt.
        wrapPrompt: (prompt) =>
          system ? `${system}\n\n---\n\n${prompt}` : prompt
      };
    },
    needsOutputFile: true,
    parse(stdout, { outputText }) {
      return String(outputText ?? stdout ?? "");
    }
  }
};

function adapterError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function describeAdapters() {
  return LLM_ADAPTER_IDS.map((id) => ({
    id,
    label: ADAPTERS[id].label,
    command: resolveCommand(id)
  }));
}

function resolveCommand(id, env = process.env) {
  const adapter = ADAPTERS[id];
  return String(env[adapter.env] || adapter.command);
}

function runProcess(
  command,
  args,
  { stdin, cwd, timeoutMs, signal, spawnImpl = spawn, env }
) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      reject(
        adapterError(
          "ADAPTER_NOT_INSTALLED",
          `Could not start ${command}: ${error instanceof Error ? error.message : String(error)}`
        )
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };
    const kill = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited
      }
    };
    const timer = setTimeout(() => {
      kill();
      finish(
        reject,
        adapterError(
          "ADAPTER_TIMEOUT",
          `${command} did not answer within ${Math.round(timeoutMs / 1000)} seconds`
        )
      );
    }, timeoutMs);
    const onAbort = () => {
      kill();
      finish(reject, adapterError("ADAPTER_ABORTED", "Request was cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_CHARS * 2) {
        kill();
        finish(reject, adapterError("ADAPTER_OUTPUT_TOO_LARGE", "CLI output exceeded the size limit"));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.on("error", (error) => {
      finish(
        reject,
        adapterError(
          error?.code === "ENOENT" ? "ADAPTER_NOT_INSTALLED" : "ADAPTER_SPAWN_FAILED",
          error?.code === "ENOENT"
            ? `${command} is not installed or not on PATH`
            : `Could not run ${command}: ${error?.message || error}`
        )
      );
    });
    child.on("close", (code) => {
      finish(resolve, { code, stdout, stderr });
    });

    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin ?? "");
  });
}

export function createLlmAdapterManager({
  spawnImpl = spawn,
  env = process.env,
  tmpRoot = os.tmpdir()
} = {}) {
  let active = 0;

  return {
    describe: describeAdapters,

    async status(id) {
      if (!LLM_ADAPTER_IDS.includes(id)) {
        throw adapterError("ADAPTER_UNKNOWN", `Unknown adapter: ${id}`);
      }
      const adapter = ADAPTERS[id];
      const command = resolveCommand(id, env);
      try {
        const result = await runProcess(command, adapter.versionArgs, {
          stdin: "",
          cwd: tmpRoot,
          timeoutMs: 8_000,
          spawnImpl,
          env
        });
        return {
          id,
          label: adapter.label,
          installed: result.code === 0,
          version: result.stdout.trim().slice(0, 80)
        };
      } catch (error) {
        return {
          id,
          label: adapter.label,
          installed: false,
          error: error.code || "ADAPTER_ERROR",
          message: error.message
        };
      }
    },

    async complete({
      adapter: id,
      model = "default",
      system = "",
      prompt,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      signal
    }) {
      if (!LLM_ADAPTER_IDS.includes(id)) {
        throw adapterError("ADAPTER_UNKNOWN", `Unknown adapter: ${id}`);
      }
      if (typeof prompt !== "string" || !prompt.trim()) {
        throw adapterError("ADAPTER_BAD_REQUEST", "prompt is required");
      }
      if (prompt.length > MAX_PROMPT_CHARS || String(system).length > MAX_PROMPT_CHARS) {
        throw adapterError("ADAPTER_BAD_REQUEST", "prompt is too large");
      }
      if (typeof model !== "string" || (model !== "default" && !MODEL_PATTERN.test(model))) {
        throw adapterError("ADAPTER_BAD_REQUEST", "model name is not valid");
      }
      if (active >= MAX_CONCURRENT) {
        throw adapterError(
          "ADAPTER_BUSY",
          "Too many subscription requests are already running"
        );
      }

      const adapter = ADAPTERS[id];
      const command = resolveCommand(id, env);
      const clampedTimeout = Math.min(
        Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 5_000),
        300_000
      );

      active += 1;
      const workDir = await mkdtemp(path.join(tmpRoot, "browserharness-llm-"));
      try {
        const outputFile = path.join(workDir, "last-message.txt");
        const built = adapter.build({ model, system: String(system) }, { outputFile });
        const stdin = built.wrapPrompt ? built.wrapPrompt(prompt) : prompt;

        const result = await runProcess(command, built.args, {
          stdin,
          cwd: workDir,
          timeoutMs: clampedTimeout,
          signal,
          spawnImpl,
          env
        });

        if (result.code !== 0) {
          throw adapterError(
            "ADAPTER_CLI_ERROR",
            `${command} exited with code ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`
          );
        }

        let outputText;
        if (adapter.needsOutputFile) {
          outputText = await readFile(outputFile, "utf8").catch(() => undefined);
        }
        const text = adapter.parse(result.stdout, { outputText }).trim();
        if (!text) {
          throw adapterError("ADAPTER_EMPTY", `${command} returned an empty response`);
        }
        return { text: text.slice(0, MAX_OUTPUT_CHARS), adapter: id };
      } finally {
        active -= 1;
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  };
}
