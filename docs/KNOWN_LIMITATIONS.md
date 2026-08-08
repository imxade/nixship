# Known Limitations

- Android hosting is best effort and can be terminated by the OS or OEM policy.
- Force-stopped Android applications cannot restart themselves.
- Nix-on-Droid is not NixOS and does not provide unavailable kernel features.
- All deployed code shares the Nix Ship account; there is no hostile workload isolation.
- The initial resource model reports usage but does not enforce hard per-app CPU or memory limits.
- Arbitrary outbound network usage is not attributed per application.
- LAN access always has stable per-app ports. Automatic Quick Tunnels provide
  temporary public URLs, but custom DNS names still require an operator-owned domain.
- LAN HTTP is unencrypted unless the user adds local TLS or uses a trusted tunnel.
- GitHub auto-deploy uses signed webhooks when a public dashboard route is available
  and periodic polling at all times as missed-delivery recovery.
- The control plane uses a custom Next.js server, so Next.js standalone output is intentionally unavailable.
- Native `better-sqlite3` must be built and validated on every supported system.
- Backup/restore is currently CLI-only.
- Host-based custom-domain routing on the dashboard listener handles ordinary HTTP; use the stable per-app port or Cloudflare route for WebSocket origins.
- Quick Tunnels are intended by Cloudflare for development/testing, have no uptime
  guarantee, cap concurrent in-flight requests, and do not support Server-Sent Events.
  Nix Ship uses polling fallbacks, but these URLs are not production SLAs.
- Every active web deployment uses a separate Quick Tunnel process. This avoids proxy
  compatibility problems but adds CPU/memory overhead that grows with the configured
  active-deployment limit and project count.
- Quick Tunnels currently have a global opt-out, not a per-application exposure
  switch. A hosted application that should not be public must enforce its own
  authentication or the operator must disable Quick Tunnels for the node.
- Cloudflare named-tunnel/OAuth integration has not been exercised against a live
  account in this environment.
- The current Android delivery path requires Nix-on-Droid and terminal setup. The plug-and-play APK, native wrapper and Android release artifacts are a roadmap target for a separate repository, not outputs of this repository.
- The Maestro CI login flow has passed on an Android 15 x86_64 development
  emulator, but no physical ARM64 Nix-on-Droid/Maestro result has been recorded;
  Android release readiness remains blocked on that evidence.
