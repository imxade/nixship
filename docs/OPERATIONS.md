# Operations

## Environment variables

See `.env.example`. The important values are:

```text
HOSTNAME=0.0.0.0
PORT=3000
PLATFORM_DATA_DIR=~/.local/share/nix-platform
PLATFORM_MASTER_KEY=<base64 32-byte key, recommended>
PLATFORM_PUBLIC_URL=<optional stable HTTPS origin>
QUICK_TUNNELS_ENABLED=true
QUICK_TUNNEL_RECONCILE_SECONDS=10
BUILD_CONCURRENCY=1
SOURCE_POLL_SECONDS=60
METRICS_INTERVAL_SECONDS=5
MIN_FREE_DISK_MB=1024
MIN_FREE_MEMORY_MB=256
PLATFORM_AI_BASE_URL=<optional OpenAI-compatible /v1 base URL>
PLATFORM_AI_MODEL=<model ID>
PLATFORM_AI_API_KEY=<optional provider key>
PLATFORM_AI_ALLOW_PRIVATE_NETWORK=false
PLATFORM_AI_TIMEOUT_SECONDS=60
```

Persistent Cloudflare integration is configured from the authenticated dashboard
with a restricted API token. The token is encrypted in SQLite and is not an
environment variable. Quick Tunnels do not use or depend on this token.

## Optional AI assistant

AI is idle unless a persisted provider/model profile or both `PLATFORM_AI_BASE_URL`
and `PLATFORM_AI_MODEL` are configured. Remote endpoints require HTTPS. To use an explicitly
trusted local OpenAI-compatible endpoint such as Ollama, set:

```bash
PLATFORM_AI_BASE_URL=http://127.0.0.1:11434/v1
PLATFORM_AI_MODEL=<installed exact tag>
PLATFORM_AI_ALLOW_PRIVATE_NETWORK=true
```

Keep external runtimes loopback-only. `PLATFORM_AI_API_KEY`
remains server-side and is sent only as the provider Authorization header. Normal
dashboard administration remains available when the model is absent or unhealthy.

Owners/admins can configure OpenAI-compatible providers through masked secure
input. Provider keys are encrypted and never returned. Conversation and planner
defaults are separate; only probe-qualified profiles can plan actions.
The model-visible messages and capabilities, strict plan format, approval boundary
and deterministic run result are documented in
[`AI_CONTROL_PLANE.md`](AI_CONTROL_PLANE.md).

Run the opt-in compatibility probe against a small local model with:

```bash
AI_LOCAL_TEST_BASE_URL=http://127.0.0.1:11434/v1 \
AI_LOCAL_TEST_MODEL=<installed exact tag> \
pnpm test:ai-local
```

The harness checks a factual answer and then runs the same versioned action-planner
probe enforced by the server: strict nested read-tool input and enums, exact tool
result use, capability search, exact capability/version planning, absence of invented
mutation tools, opaque-secret handling and completion within the six-step budget. It
reports each check independently and exits non-zero on any failure.

### Flake-pinned Ollama development shell

The optional AI development shell supplies the Ollama binary from the exact
`nixpkgs` revision in `flake.lock` without adding it to the normal Nix Ship package:

```bash
nix develop .#ai
ollama serve
```

The shell binds Ollama to `127.0.0.1:11434`, places models below
`$PLATFORM_DATA_DIR/ai/ollama/models`, and configures the compatible API URL used by
Nix Ship and the local-model harness. In another AI shell:

```bash
ollama pull <exact-model-tag>
export PLATFORM_AI_MODEL=<exact-model-tag>
export AI_LOCAL_TEST_MODEL=<exact-model-tag>
pnpm test:ai-local
pnpm dev
```

The production flake also exposes `packages.ollama`. Managed Ollama is absent from
the base Nix Ship closure: approved runtime enablement realizes the pinned reference
into a data-directory GC root and starts it on loopback. Pull/remove actions use
normal plan approval, with real pull progress in the assistant. Disable stops the
owned process without deleting weights.

## First-run claim

On an empty data directory, Nix Ship prints a visually separated LAN setup URL
(or a local URL when explicitly bound to loopback).
When the dashboard Quick Tunnel starts successfully, it prints a second
visually separated URL for that route. If Quick Tunnels are disabled or
`cloudflared` cannot start, only the LAN URL is shown.

Each URL contains the one-time claim credential. Opening it exchanges the
credential for a 30-minute HttpOnly setup cookie and redirects to the clean
`/setup` address, where the owner chooses a username and password. The setup
form never asks for or submits the token. It is a native POST form with an
enhanced client-side handler, so submission remains secure and functional if
JavaScript has not hydrated or is disabled. Successful account creation
consumes the token, removes its private local file, and signs in the new owner.

Authenticated users can change their own password from **Account** after
confirming the current password. The current browser remains signed in and the
user's other sessions are revoked. Sign out is available from the navigation
sidebar.

## Backup

Create a consistent backup with `pnpm backup -- /path/to/target` or `nixship-backup`. The target must not already exist. It uses SQLite's online backup API, archives application data, writes SHA-256 checksums, and atomically publishes the completed backup directory. Preserve:

- SQLite database;
- secrets key or external master key;
- application persistent data;
- optionally logs and Git mirrors.

The Nix store and releases can be reconstructed from repositories and lock files. When `PLATFORM_MASTER_KEY` is externally managed, it is deliberately not copied into the backup and must be supplied during verification/restore.

Restore with `pnpm restore -- /path/to/backup` while Nix Ship is stopped. Restore verifies the manifest, every checksum, archive paths, the master-key mode, SQLite integrity, and foreign keys before replacing current state. A failed replacement rolls the previous database, key, and application directory back into place.

## Automatic deployment

Nix Ship registers the GitHub App webhook against the best public dashboard route:
custom domain, explicit stable URL, then current dashboard Quick Tunnel. LAN routes
are never used. Branch polling runs periodically regardless of webhook availability
and queues each previously unseen commit once. A failed commit is not retried on
every poll; use **Redeploy latest** for a transient host failure, or push a new
commit with the repository fix.

Harbur connections use the same `SOURCE_POLL_SECONDS` interval. A public-only manual connection
needs no token. For private repositories and automatic merge deployment, configure a random
`INTEGRATION_READ_TOKEN` on Harbur, then connect its origin and token from **Harbur** in the
dashboard. Nix Ship encrypts the token and polls Harbur's durable event cursor; a merged pull request queues its
exact immutable SHA-256 snapshot once. Rotating the Harbur token requires verifying the same
origin again. Disconnect is blocked while applications still reference the connection. See
[`HARBUR_INTEGRATION_DESIGN.md`](HARBUR_INTEGRATION_DESIGN.md) for the trust and archive boundary.

## Temporary public access

Nix Ship supervises the dashboard Quick Tunnel and one process per active web deployment.
Each URL remains stable while that deployment and its tunnel process continue running. A graceful
Nix Ship shutdown closes managed Quick Tunnels; after a crash, device reboot, or later
restart, a replacement process can receive a new URL. Set
`QUICK_TUNNELS_ENABLED=false` before startup to keep the node LAN/custom-domain
only. Quick Tunnel URLs remain enabled alongside custom domains.

`cloudflared` can print an assigned hostname before its DNS record is usable.
Nix Ship keeps that route in **Preparing** and does not expose a clickable URL
until Cloudflare's public DNS-over-HTTPS resolver returns an address and the
public edge reaches the dashboard or intended application proxy. Readiness is
retried for 90 seconds before the process is recycled with backoff.

The System page stores the global active-deployment limit (1–20). It applies
independently to each project; lowering it immediately supersedes and stops each
project's oldest excess releases and their tunnels. Deployment records and logs remain
as history. A healthy retained release can be promoted from the project page when at
least one production domain is configured; this switches the stable project route
without rebuilding or replacing either release.

Source development must use `npm run dev` or `pnpm dev` to run the
lifecycle-owning custom server. Quick Tunnels require `cloudflared` on `PATH`, or
its absolute path in `CLOUDFLARED_BIN`. Starting Next.js directly
bypasses tunnel cleanup and is unsupported.

The development command forwards Next.js HMR WebSocket upgrades. At startup,
Next.js allows the host's current non-loopback LAN IPv4 addresses as development
origins; restart the command after changing networks so the allowlist is
recomputed. The custom server also accepts the dashboard Quick Tunnel's strict
same-origin HMR upgrade when it arrives from local `cloudflared`; other Quick
Tunnel origins remain blocked. This development-only handling does not alter
production origin checks.

## Recovery

- If the dashboard crashes, detached active apps should continue.
- Restart Nix Ship; it reconciles process records and deployment state.
- Interrupted builds are marked interrupted rather than assumed successful.
- If SQLite integrity fails, stop the service and restore a verified backup; do not delete the database blindly.
- If the encryption key is lost, encrypted GitHub/Cloudflare/application secrets cannot be recovered.
- If the Cloudflare API token is revoked or expires, replace it from the
  Cloudflare page. Existing LAN routes continue operating.

## Log retention

Completed deployment logs are removed after `LOG_RETENTION_DAYS` and oldest inactive logs are removed when total log usage exceeds `LOG_MAX_MB`. If active append targets alone exceed the hard cap, they are truncated in place so the running process keeps its file descriptor while disk use remains bounded. Metric samples are pruned after seven days.

## Nix store pressure

Nix Ship checks free filesystem space before builds but does not automatically garbage-collect the Nix store. Run garbage collection deliberately after confirming no required generations or roots will be removed. Automated or dashboard-triggered garbage collection is outside the current product contract because it cannot yet show and preserve the exact required closure safely.

## Updating

1. Stop accepting new deployments.
2. Build and test the new control-plane package.
3. Stop only the Next.js control plane.
4. Start the new version against the existing data directory.
5. Verify migrations and process reconciliation.
6. Roll back the control-plane package if startup fails.

Do not automatically restart active hosted applications solely for a dashboard update.
