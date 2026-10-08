// The helper app's own window and the shortcuts that open it: a Start menu
// and desktop shortcut on Windows, an app in ~/Applications on a Mac, an
// apps-menu entry on Linux. The window itself is the local page from
// setup-page.mjs, shown as a plain app window in Chrome or Edge.
import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

export const HELPER_NAME = "BrowserHarness Helper";
const MANAGED = "managed by browserharness-bridge";

// The extension's 128px icon (apps/extension/public/icons/icon128.png).
const ICON_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAABc0lEQVR4nO3SsQ3CQBBFQRdBQEqXxJTj/i42CQ0gjHz2m+DF+7Wa5XZ/bOq2HD1AAAgAASAABIAAEAACQAAIAAEgAASAZgQwxtAEARAPgHgAxAMgHgDxAIgHQDwA4gEQD4B4AMQ7DYBfbpUCIB4A8QCIB0A8AOIBEA+AeADEAyAeAPEAiAfAp+e67da3t9fXtluz/RUAAAAAAAAAAAAAAAAAAAAAAAAAYLqhAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwGxDAQAAAAAAyAKoBkA8AOIBEA+AeADEAyAeAPEAiAdAPADiARDvsgD0nwCIB0A8AOIBEA+AeADEAyAeAPEAiAdAPADiHQZA5w+AeADEAyAeAPEAiAdAPADiARAPgHgAxAMgHgDxAIgHQLw3/Xww47zgqjgAAAAASUVORK5CYII=",
  "base64"
);

/** A Windows .ico holding the 128px PNG (Windows Vista and newer read PNG inside .ico). */
export function icoFromPng(png, size = 128) {
  const header = Buffer.alloc(6 + 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(size >= 256 ? 0 : size, 6);
  header.writeUInt8(size >= 256 ? 0 : size, 7);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}

/** A Mac .icns holding the 128px PNG as its "ic07" image. */
export function icnsFromPng(png) {
  const entry = Buffer.alloc(8);
  entry.write("ic07", 0, "ascii");
  entry.writeUInt32BE(8 + png.length, 4);
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(8 + 8 + png.length, 4);
  return Buffer.concat([head, entry, png]);
}

/** Where each computer keeps the shortcut. */
export function shortcutPaths(ctx) {
  if (ctx.platform === "darwin") {
    return { kind: "mac-app", app: path.join(ctx.home, "Applications", `${HELPER_NAME}.app`) };
  }
  if (ctx.platform === "win32") {
    return { kind: "windows-shortcut", launcher: path.join(ctx.home, ".browserharness-bridge", "bin", "open-helper.vbs") };
  }
  const dataHome = ctx.env.XDG_DATA_HOME || path.join(ctx.home, ".local", "share");
  return { kind: "linux-desktop", file: path.join(dataHome, "applications", "browserharness-helper.desktop") };
}

const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
const shQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

function windowsShortcutScript({ create, launcher, icon }) {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "$folders = @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))",
    "foreach ($folder in $folders) {",
    `  $file = Join-Path $folder ${psQuote(`${HELPER_NAME}.lnk`)}`
  ];
  if (create) {
    lines.push(
      "  $shell = New-Object -ComObject WScript.Shell",
      "  $link = $shell.CreateShortcut($file)",
      "  $link.TargetPath = Join-Path $env:WINDIR 'System32\\wscript.exe'",
      `  $link.Arguments = '"' + ${psQuote(launcher)} + '"'`,
      `  $link.IconLocation = ${psQuote(icon)}`,
      "  $link.Description = 'Open the BrowserHarness helper app'",
      "  $link.Save()"
    );
  } else {
    lines.push("  if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }");
  }
  lines.push("}");
  return lines.join("\r\n");
}

/**
 * Adds the "BrowserHarness Helper" shortcut that opens the helper's window.
 * Returns where it went, or a note when this computer wouldn't take it.
 */
export async function installShortcuts(ctx) {
  const where = shortcutPaths(ctx);
  const bin = path.join(ctx.home, ".browserharness-bridge", "bin");
  await mkdir(bin, { recursive: true });

  if (where.kind === "windows-shortcut") {
    const icon = path.join(bin, "helper.ico");
    await writeFile(icon, icoFromPng(ICON_PNG));
    const q = (value) => `""${value}""`;
    await writeFile(
      where.launcher,
      `' ${MANAGED}\r\nCreateObject("WScript.Shell").Run "${q(ctx.nodePath)} ${q(ctx.cliPath)} app", 0, False\r\n`
    );
    const script = path.join(bin, "make-shortcuts.ps1");
    await writeFile(script, windowsShortcutScript({ create: true, launcher: where.launcher, icon }));
    const result = ctx.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script]);
    await rm(script, { force: true });
    return result.code === 0
      ? { ...where, created: true }
      : { ...where, created: false, note: result.stderr.trim() || "Windows didn't make the shortcut" };
  }

  if (where.kind === "mac-app") {
    const contents = path.join(where.app, "Contents");
    await rm(where.app, { recursive: true, force: true });
    await mkdir(path.join(contents, "MacOS"), { recursive: true });
    await mkdir(path.join(contents, "Resources"), { recursive: true });
    await writeFile(
      path.join(contents, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${HELPER_NAME}</string>
  <key>CFBundleDisplayName</key><string>${HELPER_NAME}</string>
  <key>CFBundleIdentifier</key><string>com.browserharness.helper</string>
  <key>CFBundleExecutable</key><string>browserharness-helper</string>
  <key>CFBundleIconFile</key><string>helper</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`
    );
    const exe = path.join(contents, "MacOS", "browserharness-helper");
    await writeFile(exe, `#!/bin/sh\n# ${MANAGED}\nexec ${shQuote(ctx.nodePath)} ${shQuote(ctx.cliPath)} app\n`);
    await chmod(exe, 0o755);
    await writeFile(path.join(contents, "Resources", "helper.icns"), icnsFromPng(ICON_PNG));
    return { ...where, created: true };
  }

  const icon = path.join(bin, "helper.png");
  await writeFile(icon, ICON_PNG);
  await mkdir(path.dirname(where.file), { recursive: true });
  const exec = (value) => `"${String(value).replace(/(["`$\\])/g, "\\$1")}"`;
  await writeFile(
    where.file,
    `[Desktop Entry]
# ${MANAGED}
Type=Application
Name=${HELPER_NAME}
Comment=Open the BrowserHarness helper app
Exec=${exec(ctx.nodePath)} ${exec(ctx.cliPath)} app
Icon=${icon}
Terminal=false
Categories=Utility;
`
  );
  return { ...where, created: true };
}

export async function uninstallShortcuts(ctx) {
  const where = shortcutPaths(ctx);
  if (where.kind === "windows-shortcut") {
    const bin = path.dirname(where.launcher);
    if (existsSync(bin)) {
      const script = path.join(bin, "remove-shortcuts.ps1");
      await writeFile(script, windowsShortcutScript({ create: false }));
      ctx.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script]);
      await rm(script, { force: true });
    }
    await rm(where.launcher, { force: true });
  } else if (where.kind === "mac-app") {
    await rm(where.app, { recursive: true, force: true });
  } else {
    await rm(where.file, { force: true });
  }
  return where;
}

/** Chrome or Edge on this computer, to show the window without tabs or an address bar. */
export function findAppBrowser({ platform = process.platform, env = process.env, home, which }) {
  if (platform === "win32") {
    const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.ProgramW6432].filter(Boolean);
    const candidates = [];
    for (const root of roots) candidates.push(path.join(root, "Google", "Chrome", "Application", "chrome.exe"));
    for (const root of roots) candidates.push(path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
    return candidates.find((file) => existsSync(file)) || null;
  }
  if (platform === "darwin") {
    const apps = ["/Applications", path.join(home || "", "Applications")];
    const names = [
      ["Google Chrome.app", "Google Chrome"],
      ["Microsoft Edge.app", "Microsoft Edge"],
      ["Chromium.app", "Chromium"]
    ];
    for (const [app, exe] of names) {
      for (const dir of apps) {
        const file = path.join(dir, app, "Contents", "MacOS", exe);
        if (existsSync(file)) return file;
      }
    }
    return null;
  }
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) {
    const found = which(name);
    if (found) return found;
  }
  return null;
}

/** Opens the helper's window: an app window in Chrome or Edge, else the usual browser. */
export function openHelperWindow(url, { browser, fallback }) {
  if (browser) {
    try {
      const child = spawn(browser, [`--app=${url}`, "--window-size=600,860"], { detached: true, stdio: "ignore", windowsHide: false });
      child.on("error", () => fallback(url));
      child.unref();
      return true;
    } catch {
      // Fall through to the usual browser.
    }
  }
  return fallback(url);
}
