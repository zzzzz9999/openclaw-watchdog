# OpenClaw Gateway Monitor — PowerShell launcher
# Run: powershell -ExecutionPolicy Bypass -File start.ps1
# Or right-click → "Run with PowerShell"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Monitor   = Join-Path $ScriptDir "monitor.js"

$host.UI.RawUI.WindowTitle = "OpenClaw Gateway Monitor"

# ── Check Node.js ────────────────────────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: Node.js is not installed." -ForegroundColor Red
    Write-Host "Install it from https://nodejs.org"
    Read-Host "Press Enter to exit"
    exit 1
}

# ── Check openclaw ───────────────────────────────────────────────────────────
if (-not (Get-Command openclaw -ErrorAction SilentlyContinue)) {
    Write-Host "WARNING: 'openclaw' not found in PATH." -ForegroundColor Yellow
    Write-Host "Install it with: npm install -g openclaw@latest"
    Write-Host ""
}

# ── Run ──────────────────────────────────────────────────────────────────────
Write-Host "Starting OpenClaw Gateway Monitor..." -ForegroundColor Cyan
Write-Host ""

node $Monitor $args

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Monitor exited with an error." -ForegroundColor Red
    Read-Host "Press Enter to exit"
}
