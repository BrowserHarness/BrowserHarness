import { access, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");

const requiredTools = [
  "observe_page",
  "read_page",
  "ax_snapshot",
  "navigate",
  "click",
  "trusted_click",
  "type",
  "trusted_type",
  "press_key",
  "trusted_key",
  "scroll",
  "wait",
  "open_tab",
  "find_tab",
  "list_tabs",
  "switch_tab",
  "close_tab",
  "screenshot",
  "dialog",
  "network",
  "upload",
  "save_pdf",
  "cdp"
]

const requiredFiles = [
  "apps/extension/dist/manifest.json",
  "apps/extension/dist/sidepanel.html",
  "apps/extension/dist/assets/service-worker.js",
  "apps/extension/dist/assets/content.js",
  "apps/extension/dist/icons/icon16.png",
  "apps/extension/dist/icons/icon32.png",
  "apps/extension/dist/icons/icon48.png",
  "apps/extension/dist/icons/icon128.png",
  "apps/extension/src/runtime/browser-engine.ts",
  "apps/extension/src/runtime/model-router.ts",
  "apps/extension/src/runtime/tab-evidence.ts",
  "apps/extension/src/runtime/history.ts",
  "apps/extension/src/content/adapters/google-docs.ts",
  "apps/extension/src/ui/HistoryView.tsx",
  "apps/extension/src/ui/MvpSettingsSections.tsx",
  "docs/release/PRIVACY.md",
  "docs/release/TERMS.md",
  "docs/release/SUPPORT.md",
  "docs/release/CHROME-WEB-STORE.md",
  "docs/qa/STABILITY-GATE.md",
  "MVP-V0.1.md",
  "machine/browser-tools.json",
  "machine/capabilities.json"
];

function fail(message) {
  throw new Error(`MVP validation failed: ${message}`);
}

for (const relative of requiredFiles) {
  const path = resolve(ROOT, relative);
  await access(path).catch(() => fail(`missing ${relative}`));
  const info = await stat(path);
  if (info.size === 0) fail(`empty ${relative}`);
}

const manifest = JSON.parse(
  await readFile(
    resolve(ROOT, "apps/extension/dist/manifest.json"),
    "utf8"
  )
);

if (manifest.manifest_version !== 3) {
  fail("extension is not Manifest V3");
}

const requiredPermissions = [
  "activeTab",
  "alarms",
  "contextMenus",
  "debugger",
  "downloads",
  "favicon",
  "notifications",
  "sidePanel",
  "scripting",
  "storage",
  "tabGroups",
  "tabs",
  "unlimitedStorage",
  "webNavigation",
  "webRequest",
  "windows"
]
for (const permission of requiredPermissions) {
  if (!manifest.permissions?.includes(permission)) {
    fail(`missing extension permission ${permission}`);
  }
}

if (!manifest.host_permissions?.includes("<all_urls>")) {
  fail("full browser-agent host access <all_urls> is missing");
}

if (manifest.content_scripts) {
  fail("runtime injection should remain dynamic rather than static");
}

const registry = JSON.parse(
  await readFile(resolve(ROOT, "machine/browser-tools.json"), "utf8")
);
const actualTools = (registry.tools || [])
  .map((tool) => tool.id)
  .sort();
if (
  JSON.stringify(actualTools) !==
  JSON.stringify([...requiredTools].sort())
) {
  fail(
    `browser tool registry mismatch: ${JSON.stringify(actualTools)}`
  );
}

const capabilities = JSON.parse(
  await readFile(resolve(ROOT, "machine/capabilities.json"), "utf8")
);
const modelRouting = capabilities.capability_domains?.find(
  (domain) => domain.id === "model-routing"
);
if (
  modelRouting?.runtime_contract?.saved_connections !== "multiple" ||
  !String(modelRouting?.runtime_contract?.routing || "").includes(
    "fallback"
  )
) {
  fail("model routing contract is not the v0.1.1 multi-connection contract");
}

// The content script is injected with chrome.scripting.executeScript, which
// cannot load ES module chunks: it must be one self-contained file.
const contentScript = await readFile(
  resolve(ROOT, "apps/extension/dist/assets/content.js"),
  "utf8"
);
if (/^\s*import\b|\bimport\s*\{[^}]*\}\s*from\s*["']/m.test(contentScript.slice(0, 2000))) {
  fail("content.js imports a shared chunk; keep content-script modules out of background/UI imports");
}

for (const size of [16, 32, 48, 128]) {
  const path = resolve(
    ROOT,
    `apps/extension/dist/icons/icon${size}.png`
  );
  const bytes = await readFile(path);
  const signature = bytes.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") {
    fail(`icon${size}.png is not a valid PNG signature`);
  }
}

console.log(
  "BrowserHarness MVP automated contract gate passed: runtime, permissions, release docs, tools, icons, and package structure are present."
);
