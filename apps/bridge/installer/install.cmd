@echo off
rem BrowserHarness Bridge installer for Windows.
where node >nul 2>nul
if errorlevel 1 (
  echo BrowserHarness Bridge needs Node.js 20 or newer. Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
node "%~dp0browserharness-bridge.mjs" install %*
pause
