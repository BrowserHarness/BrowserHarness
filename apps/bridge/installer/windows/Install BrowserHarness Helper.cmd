@echo off
rem Double-click to install the BrowserHarness helper app. It brings its own
rem Node, installs into your user folder and opens a setup page in your browser.
title BrowserHarness helper app
set BROWSERHARNESS_BUNDLED_NODE=1
"%~dp0runtime\node.exe" "%~dp0browserharness-bridge.mjs" setup
if errorlevel 1 (
  echo.
  echo Something went wrong ^(see the message above^). Close this window and double-click the installer again.
  pause
)
