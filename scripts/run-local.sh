#!/usr/bin/env bash
set -euo pipefail
export HOSTNAME="${HOSTNAME:-0.0.0.0}"
export PORT="${PORT:-3000}"
export PLATFORM_DATA_DIR="${PLATFORM_DATA_DIR:-$HOME/.local/share/nix-platform}"
mkdir -p "$PLATFORM_DATA_DIR"
exec pnpm start
