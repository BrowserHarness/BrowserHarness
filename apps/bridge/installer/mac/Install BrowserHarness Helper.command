#!/bin/bash
# Double-click to install the BrowserHarness helper app. It brings its own Node,
# installs into your home folder and opens a setup page in your browser.
cd "$(dirname "$0")" || exit 1
export BROWSERHARNESS_BUNDLED_NODE=1
if ! ./runtime/node ./browserharness-bridge.mjs setup; then
  echo
  echo "Something went wrong (see the message above). Close this window and double-click the installer again."
fi
