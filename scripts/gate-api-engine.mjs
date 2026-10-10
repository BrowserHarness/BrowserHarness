#!/usr/bin/env node
// The native API engine's regression gate, run locally before a release
// candidate (never on GitHub Actions): the vendored upstream is unchanged,
// the Bridge and extension tests pass, the extension typechecks and builds,
// and the real-Chromium fixture test passes. Prints one line per step and
// exits non-zero on the first failure.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const steps = [
  ["vendored upstream matches its pinned commit", npm, ["run", "vendor:check"]],
  ["Bridge tests", npm, ["test", "-w", "@browserharness/bridge"]],
  ["extension tests", npm, ["test", "-w", "@browserharness/extension"]],
  ["extension typecheck", npm, ["run", "typecheck"]],
  ["extension build", npm, ["run", "build"]],
  ["Bridge bundle", npm, ["run", "build:bridge"]],
  ["MV3 contract", npm, ["run", "validate:mvp"]],
  ["real-Chromium API engine test (local fixture)", npm, ["run", "smoke:api-engine"]]
];
if (process.argv.includes("--quick")) steps.splice(steps.length - 1, 1);

for (const [name, cmd, args] of steps) {
  const started = Date.now();
  const run = spawnSync(cmd, args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const output = `${run.stdout || ""}${run.stderr || ""}`;
  const counts = output.match(/# pass \d+|Tests\s+\d+ passed[^\n]*|\d+\/\d+ API engine checks passed/g);
  if (run.status !== 0) {
    console.log(`FAIL ${name} (${seconds} s)`);
    console.log(output.split("\n").slice(-40).join("\n"));
    process.exit(1);
  }
  console.log(`PASS ${name} (${seconds} s)${counts ? ` — ${counts.at(-1).trim()}` : ""}`);
}
console.log("API engine gate passed");
