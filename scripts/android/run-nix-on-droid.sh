#!/usr/bin/env bash
set -euo pipefail

mode="${1:-verify}"
case "$mode" in
  verify | serve-ci) ;;
  *)
    echo "Usage: scripts/android/run-nix-on-droid.sh [verify|serve-ci]" >&2
    exit 2
    ;;
esac

if [[ ! -f flake.nix || ! -f package.json ]]; then
  echo "Run this script from the Nix Ship repository root." >&2
  exit 2
fi

architecture="$(uname -m)"
case "$architecture" in
  aarch64 | arm64) ;;
  *)
    echo "Physical Nix-on-Droid acceptance requires ARM64; found $architecture." >&2
    exit 1
    ;;
esac

for executable in nix nix-on-droid git; do
  if ! command -v "$executable" >/dev/null 2>&1; then
    echo "Missing required Nix-on-Droid command: $executable" >&2
    exit 1
  fi
done

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
evidence_root="${ANDROID_EVIDENCE_DIR:-$PWD/artifacts/android}"
evidence_directory="$evidence_root/nix-on-droid-$timestamp"
mkdir -p "$evidence_directory"
exec > >(tee "$evidence_directory/nix-on-droid.log") 2>&1

echo "timestamp=$timestamp"
echo "architecture=$architecture"
echo "android_release=${ANDROID_VERSION:-record-from-device-settings}"
echo "nix_on_droid=$(nix-on-droid --version 2>&1 | head -n 1)"
echo "nix=$(nix --version)"
echo "node=$(nix develop --command node --version)"
echo "pnpm=$(nix develop --command pnpm --version)"
echo "system=$(nix eval --raw --impure --expr builtins.currentSystem)"
echo "memory_kib=$(awk '/MemTotal/ { print $2 }' /proc/meminfo)"

if [[ "$mode" == "serve-ci" ]]; then
  nix develop --command pnpm install --frozen-lockfile
  nix develop --command pnpm build
  echo "Starting the explicit loopback-only CI server for Maestro."
  exec nix develop --command pnpm start:ci
fi

nix develop --command pnpm install --frozen-lockfile
nix develop --command pnpm biome:ci
nix develop --command pnpm typecheck
nix develop --command pnpm test
nix develop --command pnpm build
nix develop --command pnpm test:examples
PLATFORM_DATA_DIR="$evidence_directory/db-doctor" nix develop --command pnpm db:doctor
PLATFORM_DATA_DIR="$evidence_directory/db-doctor" nix develop --command pnpm security:check
nix flake check --print-build-logs
nix build --print-build-logs

echo "Nix-on-Droid verification completed. Physical lifecycle and LAN checks remain separate gates."
