#!/usr/bin/env bash
# OpenClaw Gateway Monitor — Unix launcher (macOS / Linux / WSL)
# Double-click or run: bash start.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONITOR="$SCRIPT_DIR/monitor.js"

# ── Check Node.js ────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is not installed."
  echo "Install it from https://nodejs.org or via nvm:"
  echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash"
  echo "  nvm install 22"
  exit 1
fi

NODE_MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "WARNING: Node.js $NODE_MAJOR detected. v18+ recommended."
fi

# ── Check openclaw ───────────────────────────────────────────────────────────
if ! command -v openclaw &>/dev/null; then
  echo "WARNING: 'openclaw' not found in PATH."
  echo "Install it with: npm install -g openclaw@latest"
  echo "Monitor will still run but cannot restart the gateway."
  echo ""
fi

# ── Run ──────────────────────────────────────────────────────────────────────
echo "Starting OpenClaw Gateway Monitor..."
exec node "$MONITOR" "$@"
