# Product Requirements Document

## Product

**Nix Ship** is a self-hosted personal PaaS for trusted Nix flake applications. A user installs or already has working Nix, opens the LAN dashboard, connects GitHub, selects a repository, and deploys. The platform rebuilds and redeploys the configured production branch automatically.

## Positioning

Nix Ship is comparable in workflow to a small Vercel, Coolify or Dokploy node, but it runs directly under the user's Nix account. It is not a VPS, VM, container runtime, NixOS installation, or security boundary.

## Initial user journey

1. Start Nix Ship on the host device.
2. Visit its LAN address.
3. Claim it with the one-time terminal token.
4. Create the owner account.
5. Connect GitHub, enter a public HTTPS GitHub repository URL, or connect Harbur once.
6. Select repository and flake app output; optionally override the repository's default branch.
7. Configure health path and environment variables.
8. Deploy.
9. Open the stable LAN endpoint.
10. Optionally connect Cloudflare and assign hostnames later.

## Functional requirements

### Host

- Listen on a configurable LAN interface and port.
- Require authentication after one-time setup.
- Persist state in SQLite with WAL and migrations.
- Recover deployment queue and desired application state after restart.
- Sample host and per-process-group resource usage.
- Refuse new builds below configured disk or memory reserves.

### Applications

- Import HTTPS GitHub repositories or immutable Harbur repository snapshots.
- Require `flake.nix` and `flake.lock`.
- Discover and validate the selected flake app output for the current Nix system.
- Support web and worker applications.
- Inject host, port, data, cache, log, application and deployment variables.
- Store user variables encrypted at rest.
- Assign web applications stable LAN proxy ports.
- Keep the old healthy release active until a candidate passes its health check.
- Support manual deploy, start, stop, restart and deletion.
- Persist deployment history and logs.

### GitHub

- Create a per-node GitHub App through the manifest flow.
- Let the user choose repository access in GitHub.
- List accessible repositories in the dashboard.
- Use short-lived installation tokens for private repository access.
- Verify webhook signatures and deduplicate delivery IDs.
- Deploy the exact pushed commit on the configured production branch.
- Reconcile branch heads periodically so LAN-only/offline nodes eventually deploy missed changes.

### Cloudflare

- Remain entirely optional.
- Create or reuse one named tunnel per host.
- Map dashboard and application hostnames to local ports.
- Create/update CNAME records for configured hostnames.
- Show the Cloudflare route state, stable origin and last synchronization result for every project hostname.
- Start and supervise cloudflared.
- Keep LAN applications running when the tunnel is disabled or disconnected.

### Users

- Owner, admin, operator and viewer roles.
- Owner cannot be disabled or demoted.
- Owner/admin can create and disable other users.
- Operators can deploy and configure applications.
- Viewers have read-only access.

## Non-functional requirements

- Strict TypeScript.
- No default production credentials. The explicit loopback-only CI startup may create documented disposable test credentials.
- No secrets returned after storage.
- No shell interpolation for Git/Nix execution.
- Bounded request sizes and log buffering.
- Deployment queue source of truth in SQLite.
- A persisted global limit of 1–20 active deployments per application and configurable
  host build concurrency.
- Mobile-responsive and keyboard-accessible dashboard.
- No claim of exact OOM attribution without evidence.
- Application processes must not depend on the dashboard process remaining alive.

## Success criteria for Android feasibility

- Nix Ship builds and starts on two ARM64 Android devices through Nix-on-Droid.
- `better-sqlite3` builds and passes integrity tests.
- A sample web flake deploys and is reachable on the LAN.
- Screen-off operation works while the Nix-on-Droid wake lock is held.
- Wi-Fi reconnect and device IP changes do not corrupt state.
- Control-plane restart leaves an active detached application running and reconnects supervision.
- Device reboot restoration is documented and verified as best effort.
- Android process termination under pressure is surfaced without false certainty.
