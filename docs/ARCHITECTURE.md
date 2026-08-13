# Architecture

## Topology

```text
LAN browser
    |
    v
custom Node HTTP server + Next.js App Router
    |-- dashboard, auth, APIs, SSE
    |-- SQLite and encrypted local state
    |-- deployment scheduler
    |-- process supervisor
    |-- metrics collector
    |-- GitHub reconciler
    |-- provider-neutral routing
    |-- Cloudflare Quick/named tunnel controllers
    |-- optional read-only AI planner + deterministic plan executor
    |-- per-app LAN proxy listeners
    |
    +--> git
    +--> nix
    +--> cloudflared Quick Tunnels (default; optional via configuration)
    +--> cloudflared named tunnel (optional custom domains)
    +--> detached flake application process groups
```

The product is a single TypeScript codebase and one main control-plane process. Deployed applications are necessarily separate processes produced by their own flakes.

## Why a custom Next.js server

The selected product constraint is “Next.js completely.” A custom Node HTTP server allows the same codebase to own a persistent lifecycle and graceful shutdown while Next.js continues to serve the dashboard and Route Handlers. This gives up Next.js standalone output; the package includes the normal production build and runtime dependencies instead.

## Boot sequence

1. Validate environment configuration.
2. Prepare Next.js before starting the persistent runtime, so a framework
   startup failure cannot leave tunnel processes or a runtime lock behind.
3. Create private data directories.
4. Acquire the exclusive runtime lock.
5. Open SQLite and transactionally apply migrations.
6. Create or recover the one-time setup token without logging it separately.
7. Mark incomplete deployments interrupted.
8. Recreate stable per-app LAN proxy listeners.
9. Reconcile active application process IDs.
10. Start metrics, Git reconciliation and deployment scheduling loops.
11. Start account-free Quick Tunnels by default and the named Cloudflare tunnel
    when configured and enabled.
12. Listen on the LAN interface and print distinctive
    token-bearing LAN/available Quick Tunnel claim links.

The runtime is also guarded on `globalThis` to avoid duplicate initialization
from Next.js development reloads or instrumentation. The custom server forwards
Next.js HTTP upgrades, and source development allows the host's current LAN IPv4
addresses so HMR works when the dashboard is opened from another LAN device. It
also admits a development HMR upgrade from the dashboard's strict, same-origin
`trycloudflare.com` URL when local `cloudflared` proxies it over loopback;
arbitrary cross-origin Quick Tunnel requests remain blocked.
Quick Tunnel URLs remain in the starting state until Cloudflare's public DNS
resolver returns an address and a request through the public edge reaches the
dashboard health endpoint or the intended application's stable proxy.

## Persistent state

```text
$PLATFORM_DATA_DIR/
  platform.sqlite
  repositories/       bare Git mirrors
  releases/           immutable worktrees per deployment
  applications/<id>/  persistent data and caches
  logs/<id>/           deployment stdout/stderr
  secrets/            host encryption key fallback
  runtime/            lock and first-run token
  backups/
```

The Nix store and release worktrees are replaceable. Application state is separate and passed as `DATA_DIR`.

AI conversations are encrypted with the existing master key. AI plans, hashes,
state snapshots, runs, step results and short-lived resource locks live in SQLite.
They do not replace application or deployment state.

## AI control boundary

```text
user -> model (read tools only) -> proposed canonical plan
     -> exact hash approval -> TypeScript executor -> domain service -> verification
```

The provider receives a system policy, recent text history, role-filtered read tools
with JSON Schemas, and four control tools: capability search, ordinary input,
secure input and strict plan proposal. Mutation descriptors are returned by search
with their ID, version, risk, roles and input JSON Schema, but their implementations
are never exposed as callable tools.

The model returns normalized text and/or typed function calls. Read results are
schema-validated and returned for another bounded model step. A plan call is parsed,
previewed against the server registry, canonicalized, hashed and persisted; it is
not executed. Exact approval later reloads the persisted plan. The executor resolves
each capability by ID/version, rechecks role and state, locks resources, validates
input/output and verifies the real effect without another model call.

The complete message, tool, plan, approval and run-result formats are documented in
[`AI_CONTROL_PLANE.md`](AI_CONTROL_PLANE.md).

AI SDK UI transports chat outcomes to the global drawer. Approved work is detached
from the request and publishes authoritative run-step, deployment and Ollama-pull
events over authenticated SSE. SQLite remains authoritative for plans and runs;
the model is not called during execution.

## Deployment state machine

```text
queued -> preparing -> fetching -> evaluating -> starting
       -> health-checking -> activating -> running
       -> failed | cancelled | superseded | interrupted
```

Claiming a queued record and moving it to `preparing` occurs transactionally. A newer queued deployment supersedes older queued deployments for the same application.

## Safe activation

- Existing healthy release remains routed.
- Candidate gets a new private local port.
- Candidate is launched in a new POSIX session/process group.
- Nix Ship checks the configured HTTP health path.
- SQLite activation and active-port switch are atomic.
- Stable LAN proxy immediately routes to the candidate.
- Previously active releases remain independently reachable, up to the persisted
  global per-project limit. The oldest excess release and its Quick Tunnel are stopped.
- Promotion changes only the production pointer used by the stable proxy and custom
  domains; it does not rebuild the selected healthy release.

Workers are required to stay alive for a startup stability window rather than expose an HTTP health endpoint.

## Process recovery

Application output goes directly to files instead of Node pipes. Detached process groups can continue after a control-plane failure. Linux recovery records and verifies PID, process-group ID, `/proc/<pid>/stat` start ticks, and a SHA-256 digest of the command identity before treating a recovered process as owned or signalling its process group. A mismatched or incomplete identity is treated as disappeared.

## LAN routing

Each web app receives:

- private candidate port, changed per deployment;
- stable public LAN proxy port, retained for the application lifetime.

The built-in Node HTTP proxy supports ordinary HTTP and WebSocket upgrades. It returns 503 while the application has no healthy active release.

Web applications can also own multiple normalized DNS hostnames. Ordinary HTTP
and WebSocket upgrade requests on the dashboard listener are dispatched by
`Host`; each app's stable port remains the local origin behind the Cloudflare
named tunnel.

Cloudflare synchronization persists one result per project hostname. The application Domains tab and the global Cloudflare page share that state, including managed/pending/error status, zone, last error and synchronization time. Removal cleanup is ownership-checked before deleting a DNS record.

Persistent Cloudflare access uses one encrypted, least-privilege API token.
Account-free Quick Tunnels remain a separate controller, schema and process set;
they neither read nor depend on the persistent connection.

## Scaling boundary

The initial host is one control-plane process and SQLite. It is designed for a personal node, not horizontal multi-node scheduling. A future central control plane must use a separate architecture and durable relay; it should not turn this SQLite node into a distributed database.
