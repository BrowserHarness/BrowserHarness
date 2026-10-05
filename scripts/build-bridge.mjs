// Builds the Bridge into one file (apps/bridge/dist/browserharness-bridge.mjs)
// plus the install scripts, so people can install it without this repository.
import { build } from "esbuild";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "apps/bridge/dist");
const outFile = path.join(outDir, "browserharness-bridge.mjs");

await mkdir(outDir, { recursive: true });
await build({
  entryPoints: [path.join(root, "apps/bridge/src/cli.mjs")],
  outfile: outFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // ws loads these native speed-ups only when they are installed.
  external: ["bufferutil", "utf-8-validate"],
  define: { __BROWSERHARNESS_BUNDLED__: "true" },
  banner: {
    js: [
      'import { createRequire as __bhCreateRequire } from "node:module";',
      "const require = __bhCreateRequire(import.meta.url);"
    ].join("\n")
  },
  legalComments: "none",
  logLevel: "warning"
});
await chmod(outFile, 0o755);
for (const script of ["install.sh", "install.cmd"]) {
  await copyFile(path.join(root, "apps/bridge/installer", script), path.join(outDir, script));
}
console.log(`Built ${path.relative(root, outFile)}`);
