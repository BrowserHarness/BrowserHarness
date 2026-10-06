#!/usr/bin/env node
// Builds the double-click helper app downloads: one zip per computer type,
// each with the official Node.js from nodejs.org (checked against its
// published SHA-256), the helper app and a launcher to double-click.
// Usage: node scripts/package-helper.mjs [--out <folder>] [--suffix <text>] [--only mac-apple,windows]
// Run `npm run build:bridge` first.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

// The Node.js LTS the helper app is tested with.
const NODE_VERSION = "22.22.0";
const NODE_DIST = `https://nodejs.org/dist/v${NODE_VERSION}`;

const TARGETS = [
  { id: "mac-apple", label: "Mac with an Apple chip (M1 or newer)", os: "mac", archive: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`, binary: "bin/node" },
  { id: "mac-intel", label: "Mac with an Intel chip", os: "mac", archive: `node-v${NODE_VERSION}-darwin-x64.tar.gz`, binary: "bin/node" },
  { id: "windows", label: "Windows 10 or 11", os: "windows", archive: `node-v${NODE_VERSION}-win-x64.zip`, binary: "node.exe" },
  { id: "linux", label: "Linux (64-bit)", os: "linux", archive: `node-v${NODE_VERSION}-linux-x64.tar.xz`, binary: "bin/node" }
];

const README = {
  mac: `BrowserHarness helper app for Mac

1. Double-click "Install BrowserHarness Helper".
   If your Mac says it can't check the app: close the message, open
   System Settings > Privacy & Security, scroll down and press "Open Anyway".
   (This shows because the app isn't signed with an Apple certificate yet.)
2. A setup page opens in your browser. Follow it: in BrowserHarness press Pair
   and type the 6-digit code on the page.
3. When the page says Connected, you can close everything and delete this folder.
`,
  windows: `BrowserHarness helper app for Windows

1. Unzip this folder first (right-click > Extract All), then open it.
2. Double-click "Install BrowserHarness Helper".
   If Windows says it protected your PC: press "More info", then "Run anyway".
   (This shows because the app isn't signed with a certificate yet.)
3. A setup page opens in your browser. Follow it: in BrowserHarness press Pair
   and type the 6-digit code on the page.
4. When the page says Connected, you can close everything and delete this folder.
`,
  linux: `BrowserHarness helper app for Linux

1. Right-click "Install BrowserHarness Helper.sh" and choose "Run as a program"
   (or open a terminal in this folder and type: ./"Install BrowserHarness Helper.sh").
2. A setup page opens in your browser. Follow it: in BrowserHarness press Pair
   and type the 6-digit code on the page.
3. When the page says Connected, you can close everything and delete this folder.
`
};

const LAUNCHER = {
  mac: "mac/Install BrowserHarness Helper.command",
  windows: "windows/Install BrowserHarness Helper.cmd",
  linux: "linux/Install BrowserHarness Helper.sh"
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: ["ignore", "inherit", "inherit"], ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

async function download(url, file) {
  if (existsSync(file)) return;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  await writeFile(file, Buffer.from(await response.arrayBuffer()));
}

const bundle = path.join(root, "apps/bridge/dist/browserharness-bridge.mjs");
if (!existsSync(bundle)) {
  console.error("Build the helper app first: npm run build:bridge");
  process.exit(2);
}
const out = path.resolve(arg("out") || path.join(root, "apps/bridge/dist/downloads"));
const suffix = arg("suffix") ? `-${arg("suffix")}` : "";
const only = arg("only")?.split(",");
const cache = path.join(os.tmpdir(), "browserharness-node-cache");
await mkdir(cache, { recursive: true });
await mkdir(out, { recursive: true });

const sums = path.join(cache, `SHASUMS256-${NODE_VERSION}.txt`);
await download(`${NODE_DIST}/SHASUMS256.txt`, sums);
const expected = Object.fromEntries(
  (await readFile(sums, "utf8"))
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).reverse())
);

for (const target of TARGETS.filter((item) => !only || only.includes(item.id))) {
  const archive = path.join(cache, target.archive);
  await download(`${NODE_DIST}/${target.archive}`, archive);
  const actual = createHash("sha256").update(await readFile(archive)).digest("hex");
  if (actual !== expected[target.archive]) {
    await rm(archive, { force: true });
    throw new Error(`Checksum mismatch for ${target.archive}; deleted it, run again.`);
  }

  const work = path.join(cache, `work-${target.id}`);
  const folder = path.join(work, "BrowserHarness Helper");
  await rm(work, { recursive: true, force: true });
  await mkdir(path.join(folder, "runtime"), { recursive: true });

  // Only the Node program and its licence are needed.
  const inside = `${target.archive.replace(/\.(tar\.gz|tar\.xz|zip)$/, "")}`;
  const extracted = path.join(work, "extract");
  await mkdir(extracted, { recursive: true });
  if (target.archive.endsWith(".zip")) {
    run("unzip", ["-q", "-o", archive, `${inside}/${target.binary}`, `${inside}/LICENSE`, "-d", extracted]);
  } else {
    run("tar", ["-xf", archive, "-C", extracted, `${inside}/${target.binary}`, `${inside}/LICENSE`]);
  }
  const nodeName = target.os === "windows" ? "node.exe" : "node";
  await copyFile(path.join(extracted, inside, target.binary), path.join(folder, "runtime", nodeName));
  if (target.os !== "windows") await chmod(path.join(folder, "runtime", nodeName), 0o755);
  await copyFile(path.join(extracted, inside, "LICENSE"), path.join(folder, "runtime", "NODE-LICENSE.txt"));

  await copyFile(bundle, path.join(folder, "browserharness-bridge.mjs"));
  const launcher = path.join(root, "apps/bridge/installer", LAUNCHER[target.os]);
  const launcherTarget = path.join(folder, path.basename(launcher));
  await copyFile(launcher, launcherTarget);
  if (target.os !== "windows") await chmod(launcherTarget, 0o755);
  const readme = README[target.os];
  await writeFile(path.join(folder, "READ ME FIRST.txt"), target.os === "windows" ? readme.replace(/\n/g, "\r\n") : readme);

  const zip = path.join(out, `browserharness-helper-${target.id}${suffix}.zip`);
  await rm(zip, { force: true });
  // -X leaves out extra file attributes; -y keeps links as links. Unix
  // permissions (the launcher and node must stay runnable) are kept.
  run("zip", ["-q", "-r", "-X", "-y", zip, "BrowserHarness Helper"], { cwd: work });
  await rm(work, { recursive: true, force: true });
  console.log(`Built ${path.relative(process.cwd(), zip)} (${target.label}, Node ${NODE_VERSION})`);
}
