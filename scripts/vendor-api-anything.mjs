#!/usr/bin/env node
// Vendors API Anything's compiled modules into apps/bridge/vendor/api-anything
// at one reviewed commit, or checks that the vendored files are unchanged.
//
//   node scripts/vendor-api-anything.mjs --check
//   node scripts/vendor-api-anything.mjs [--from <checkout>] [--commit <sha>]
//
// Without --from it clones the upstream repository at the commit, installs its
// dev dependencies and builds it. See docs/architecture/API-ENGINE-ADR.md.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = path.join(root, "apps/bridge/vendor/api-anything");
const manifestFile = path.join(vendorDir, "VENDORED.json");
const REPOSITORY = "https://github.com/goodnight000/api-anything";
const DEFAULT_COMMIT = "fe5cca70fe145634e49a1c9ba1f3e8250b291bea";

// cli.js, mcp.js and index.js are left out: BrowserHarness has its own CLI and
// re-hosts the four MCP tools on its MCP v2 server SDK (src/api-engine/upstream-mcp.mjs).
const MODULES = [
  "browser.js",
  "classify.js",
  "codec.js",
  "execute.js",
  "extract.js",
  "heal.js",
  "http.js",
  "import.js",
  "learn.js",
  "login.js",
  "outline.js",
  "secrets.js",
  "session.js",
  "spec.js",
  "store.js",
  "types.js"
];

// The one patch: BrowserHarness has one browser runtime (the extension), so
// upstream's Playwright tiers, capture and login window are unavailable here.
const PATCHES = [
  {
    file: "dist/browser.js",
    from: 'from "playwright-core";',
    to: 'from "../playwright-unavailable.js";',
    reason: "BrowserHarness has one browser runtime; upstream Playwright tiers are disabled"
  }
];

const STUB = `// BrowserHarness patch (see VENDORED.json): stands in for playwright-core.
// BrowserHarness drives the browser through its extension only, so upstream's
// own Chrome tiers, capture and login window never start here.
export class BrowserTierUnavailable extends Error {
  constructor() {
    super(
      "BROWSERHARNESS_BROWSER_TIER_UNAVAILABLE: API Anything's own browser is not used inside BrowserHarness; " +
        "BrowserHarness runs in-page and browser tiers through its extension"
    );
    this.name = "BrowserTierUnavailable";
  }
}
const unavailable = async () => {
  throw new BrowserTierUnavailable();
};
export const chromium = {
  launch: unavailable,
  launchPersistentContext: unavailable,
  connectOverCDP: unavailable,
  executablePath: () => ""
};
`;

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
}

async function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}

async function check() {
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const problems = [];
  for (const [file, hash] of Object.entries(manifest.files)) {
    const full = path.join(vendorDir, file);
    if (!existsSync(full)) {
      problems.push(`missing ${file}`);
      continue;
    }
    if (sha256(await readFile(full)) !== hash) problems.push(`changed ${file}`);
  }
  const present = (await listFiles(vendorDir)).filter((file) => file !== "VENDORED.json");
  for (const file of present) {
    if (!(file in manifest.files)) problems.push(`unexpected ${file}`);
  }
  if (problems.length) {
    console.error(`Vendored API Anything does not match VENDORED.json:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`Vendored API Anything ${manifest.commit.slice(0, 7)}: ${Object.keys(manifest.files).length} files match`);
}

async function vendor() {
  const commitIndex = process.argv.indexOf("--commit");
  const commit = commitIndex > 0 ? process.argv[commitIndex + 1] : DEFAULT_COMMIT;
  const fromIndex = process.argv.indexOf("--from");
  let source = fromIndex > 0 ? path.resolve(process.argv[fromIndex + 1]) : "";
  let temp = "";

  if (!source) {
    temp = await mkdtemp(path.join(os.tmpdir(), "api-anything-"));
    source = path.join(temp, "api-anything");
    run("git", ["clone", "--filter=blob:none", REPOSITORY, source], temp);
    run("git", ["checkout", "--quiet", commit], source);
  }
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).stdout.trim();
  if (head !== commit) throw new Error(`${source} is at ${head}, expected ${commit}`);
  if (!existsSync(path.join(source, "dist/learn.js"))) {
    run("npm", ["ci"], source);
    run("npm", ["run", "build"], source);
  }

  await rm(vendorDir, { recursive: true, force: true });
  await mkdir(path.join(vendorDir, "dist"), { recursive: true });
  for (const name of MODULES) {
    let text = await readFile(path.join(source, "dist", name), "utf8");
    for (const patch of PATCHES.filter((item) => item.file === `dist/${name}`)) {
      if (!text.includes(patch.from)) throw new Error(`patch target not found in ${patch.file}`);
      text = text.replace(patch.from, patch.to);
    }
    await writeFile(path.join(vendorDir, "dist", name), text);
  }
  await writeFile(path.join(vendorDir, "playwright-unavailable.js"), STUB);
  await cp(path.join(source, "sites"), path.join(vendorDir, "sites"), { recursive: true });
  await cp(path.join(source, "LICENSE"), path.join(vendorDir, "LICENSE"));
  // The bundled site specs as a module, so the single-file Bridge carries them;
  // the adapter seeds them into its own sites folder (upstream-mcp.mjs).
  const sites = {};
  for (const file of (await readdir(path.join(source, "sites"))).sort()) {
    sites[file] = await readFile(path.join(source, "sites", file), "utf8");
  }
  await writeFile(
    path.join(vendorDir, "sites-index.js"),
    `// Generated by scripts/vendor-api-anything.mjs from upstream sites/.\nexport const BUNDLED_SITES = ${JSON.stringify(sites, null, 1)};\n`
  );
  const upstreamPackage = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
  // store.js finds the bundled sites at ../sites and mcp/version code reads ../package.json.
  await writeFile(
    path.join(vendorDir, "package.json"),
    JSON.stringify(
      {
        name: upstreamPackage.name,
        version: upstreamPackage.version,
        license: upstreamPackage.license,
        type: "module",
        private: true,
        description: "Vendored by BrowserHarness; see VENDORED.json"
      },
      null,
      2
    ) + "\n"
  );

  const files = {};
  for (const file of await listFiles(vendorDir)) {
    files[file] = sha256(await readFile(path.join(vendorDir, file)));
  }
  await writeFile(
    manifestFile,
    JSON.stringify(
      {
        upstream: REPOSITORY,
        commit,
        version: upstreamPackage.version,
        license: "MIT, Copyright (c) 2026 Tianjun Zheng (LICENSE in this folder)",
        upstream_node_engine: upstreamPackage.engines?.node,
        runtime_dependencies: ["node-html-parser", "tldts", "zod"],
        excluded_modules: ["cli.js", "mcp.js", "index.js"],
        patches: PATCHES,
        files
      },
      null,
      2
    ) + "\n"
  );
  if (temp) await rm(temp, { recursive: true, force: true });
  console.log(`Vendored API Anything ${commit.slice(0, 7)} into ${path.relative(root, vendorDir)}`);
}

if (process.argv.includes("--check")) await check();
else await vendor();
