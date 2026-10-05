#!/usr/bin/env bash
# BrowserHarness Bridge installer for macOS and Linux.
# Lets Claude Code, Codex, Cursor and Hermes use your Chrome through BrowserHarness.
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "BrowserHarness Bridge needs Node.js 20 or newer. Install it from https://nodejs.org and run this again."
  exit 1
fi
major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 20 ]; then
  echo "BrowserHarness Bridge needs Node.js 20 or newer (you have $(node -v)). Update it from https://nodejs.org."
  exit 1
fi

dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
bundle="${dir:+$dir/}browserharness-bridge.mjs"

if [ ! -f "$bundle" ]; then
  url="${BROWSERHARNESS_BRIDGE_URL:-}"
  if [ -z "$url" ]; then
    echo "Run this script from the BrowserHarness Bridge folder, next to browserharness-bridge.mjs."
    exit 1
  fi
  bundle="$(mktemp -t browserharness-bridge.XXXXXX).mjs"
  curl -fsSL "$url" -o "$bundle"
fi

# Ask for the pairing code on the terminal even when this script is piped.
if [ -r /dev/tty ] && [ -t 1 ]; then
  node "$bundle" install "$@" </dev/tty
else
  node "$bundle" install "$@"
fi
