#!/usr/bin/env bash
set -euo pipefail
fail=0
for command in node pnpm git nix; do
  if command -v "$command" >/dev/null 2>&1; then printf 'ok  %-12s %s\n' "$command" "$(command -v "$command")"; else printf 'ERR %-12s missing\n' "$command"; fail=1; fi
done
cloudflared_bin="${CLOUDFLARED_BIN:-cloudflared}"
if command -v "$cloudflared_bin" >/dev/null 2>&1; then
  printf 'ok  %-12s %s\n' cloudflared "$(command -v "$cloudflared_bin")"
elif [[ "${QUICK_TUNNELS_ENABLED:-true}" =~ ^(0|false|no|off)$ ]]; then
  printf 'note %-12s missing (%s); temporary and named Cloudflare tunnels are unavailable\n' cloudflared "$cloudflared_bin"
else
  printf 'ERR %-12s missing (%s); required while Quick Tunnels are enabled\n' cloudflared "$cloudflared_bin"
  fail=1
fi
printf '\nNode: %s\n' "$(node --version 2>/dev/null || true)"
printf 'Nix system: %s\n' "$(nix eval --raw --impure --expr builtins.currentSystem 2>/dev/null || echo unavailable)"
printf 'Architecture: %s\n' "$(uname -m)"
printf 'Kernel: %s\n' "$(uname -srm)"
exit "$fail"
