@echo off
:: OpenClaw Gateway Monitor — Windows launcher
:: Double-click this file to start monitoring

title OpenClaw Gateway Monitor

set "SCRIPT_DIR=%~dp0"
set "MONITOR=%SCRIPT_DIR%monitor.js"

:: ── Check Node.js ────────────────────────────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not installed.
    echo Install it from https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: ── Check openclaw ───────────────────────────────────────────────────────────
where openclaw >nul 2>&1
if errorlevel 1 (
    echo WARNING: 'openclaw' not found in PATH.
    echo Install it with: npm install -g openclaw@latest
    echo Monitor will still run but cannot restart the gateway.
    echo.
)

:: ── Run ──────────────────────────────────────────────────────────────────────
echo Starting OpenClaw Gateway Monitor...
echo.
node "%MONITOR%" %*
if errorlevel 1 (
    echo.
    echo Monitor exited with an error.
    pause
)
