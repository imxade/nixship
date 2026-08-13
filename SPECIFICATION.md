# Nix Ship Specification

This file is the compact implementation contract. Detailed rationale and operational guidance live under `docs/`.

## Product boundary

Nix Ship is a personal application host. It runs as one persistent self-hosted Next.js and TypeScript control plane on any Nix-capable Linux or macOS host. It is not a VPS, virtual machine, container runtime, NixOS installation, or multi-tenant sandbox. Android support through Nix-on-Droid is tracked in [`docs/ANDROID.md`](docs/ANDROID.md) and the future APK distribution will live in a separate repository.

Only trusted GitHub repositories and verified immutable Harbur snapshots are accepted. Every production deployment requires `flake.nix`, `flake.lock`, and a runnable `apps.<system>.<name>` output. The locked flake is the only discovery and execution entry point. The normal deployment path never accepts arbitrary dashboard shell commands.

## Required behavior

1. Distinctive terminal links for the LAN address and, when available, the
   dashboard Quick Tunnel carry a one-time claim token. Opening either link
   authorizes owner creation without a token-entry field, and successful owner
   creation starts an authenticated session. Setup and all other
   credential-bearing forms submit through POST even before or without
   client-side JavaScript; credentials must never fall back to URL query
   parameters.
2. Every dashboard/API operation requires an authenticated role after setup.
3. GitHub is connected from the dashboard through a per-node GitHub App
   manifest flow. LAN manifests use an inactive reserved public hook URL because
   GitHub rejects both blank and private hook URLs, subscribe only to `push`,
   and synchronize installation repository selections on the setup return.
4. The Applications page offers GitHub connection directly. After installation,
   the user searches the complete paginated repository set available to every
   active App installation and selects a flake app output. Repositories not
   granted to the GitHub App remain inaccessible. An omitted branch resolves
   from the remote symbolic `HEAD`, with `main` used only when no symbolic
   default is advertised.
5. Push webhooks deploy the exact production-branch commit when the node is public.
6. Periodic branch reconciliation catches pushes missed while the node was LAN-only or offline.
7. Candidate releases receive private local ports; web apps retain stable LAN proxy ports.
8. The current healthy release remains routed until the candidate passes readiness/health checks.
9. Application processes run in detached POSIX process groups and write to file-backed logs.
10. Desired application state, queue state, users, sessions, integrations, and history persist in SQLite.
11. Secrets are encrypted at rest and existing secret values are never returned by APIs.
12. Host and per-application resource data are shown without claiming exact OOM causality when evidence is insufficient.
13. Cloudflare Tunnel remains optional. An owner-supplied least-privilege API
    token is encrypted at rest and used to discover zones, onboard missing full
    zones, manage DNS and create a persistent named tunnel.
14. Restart recovery must preserve running application processes where the host permits it.
15. Web applications may have multiple normalized custom domains. Apex domains and
    subdomains are independent assignments, but one normalized hostname can belong
    to only one application or the dashboard across the node. Persistent public
    custom domains are managed through the optional Cloudflare named tunnel while
    each application keeps its stable LAN origin.
16. Failed password checks are bounded in one-hour windows by source and username, and throttled responses provide retry timing.
17. Every project hostname exposes a persisted Cloudflare route result: managed,
    pending/not configured, or failed.
18. Cloudflare credentials are stored only after token and account tunnel access
    are verified. Stored tokens are never returned. Nix Ship does not create
    account-free or Vercel-style default persistent public domains.
19. Authenticated application, user, integration and settings flows remain
    operable without horizontal overflow on phone, tablet and desktop screens.
20. Every authenticated user can change their own password after confirming the
    current password. A successful change retains the initiating session and
    revokes that user's other sessions.
21. Dashboard data failures leave the initial loading state, show the error and
    provide a retry action instead of displaying an indefinite spinner.
22. The custom server preserves WebSocket upgrades for host-routed applications
    and, during source development, for Next.js HMR from the host's current LAN
    addresses and the dashboard's same-origin Quick Tunnel.
23. A Quick Tunnel URL is not presented as available until its
    `trycloudflare.com` hostname is present in public DNS and Cloudflare's public
    edge reaches the intended local route. A control-plane startup failure
    before the HTTP server is ready must not leave tunnel processes or
    persistent-runtime state behind.
24. Each active web deployment has its own temporary Quick Tunnel URL. A persisted
    global retention limit is enforced independently per project, with deterministic
    oldest-first deactivation while deployment history remains stored.
25. A healthy retained deployment can be promoted without a rebuild when the project
    has a production domain. The production pointer and stable proxy route change
    atomically; projects without a domain reject promotion without changing state.
26. Persistent-domain reconciliation must not overwrite or delete an existing DNS
    record unless its tunnel target and Nix Ship ownership marker prove that this
    instance owns it. Named-tunnel configuration writes are serialized. Persistent
    domain assignment must not start, stop, rotate, or otherwise mutate Quick Tunnels.
27. AI-originated platform mutations must be persisted as immutable, canonicalized
    plans and approved against their exact hash by the authenticated human actor.
    The planning model receives read-only capabilities only; deterministic Nix Ship
    code rechecks RBAC and resource state, executes registered typed capabilities,
    and verifies results without another model decision.

## Android distribution tracks

The current Android track runs Nix Ship through Nix-on-Droid. It is not release-validated until the complete host and dashboard flow passes on physical ARM64 Android devices. Device acceptance combines command-level Nix-on-Droid checks with Maestro automation of the Android browser UI, including setup, authentication, GitHub connection, application creation, deployment status, LAN access and session expiry.

The future distribution target is a self-contained APK with no separate Nix-on-Droid installation or terminal setup. The APK must start and supervise the local control plane through an Android foreground-service platform adapter, open an embedded or system web interface for first-run configuration, preserve the existing Next.js/TypeScript control plane and Nix flake deployment contract, and surface lifecycle failures honestly. It must package or safely provision every required runtime component, satisfy Android packaging and licensing requirements, and pass the same physical-device gate before release. APK source, native wrapper code, signing, binaries and store distribution are out of scope for this repository and will live in a separate Android distribution repository.

Both tracks retain the same network contract: authenticated local access over LAN, with optional authenticated Cloudflare exposure. An APK must not weaken Nix Ship roles, sessions, origin validation, GitHub permissions or Cloudflare Access guidance.

## Application runtime contract

A runnable flake app must remain in the foreground and accept injected operational variables:

```text
MANAGED_DEPLOYMENT=1
APP_ID
APP_NAME
DEPLOYMENT_ID
RELEASE_DIR
DATA_DIR
CACHE_DIR
LOG_DIR
HOST=127.0.0.1       # web only
PORT=<private port>   # web only
```

Mutable application data belongs under `DATA_DIR`. Applications may not assume root, systemd, Docker, KVM, privileged ports, kernel modules, or unavailable CPU architectures.

## Initial supported repository source

Accepted fallback URL form:

```text
https://github.com/<owner>/<repository>[.git]
```

Credentials embedded in URLs, query strings, fragments, alternate hosts, local paths, SSH URLs, and arbitrary remote Git servers are rejected. Private repositories use short-lived GitHub App installation tokens.

## Safety and trust

A flake can execute arbitrary evaluation, build, and runtime code as the Nix Ship OS account. Nix reproducibility is not workload isolation. Only the node owner’s trusted repositories may be deployed.

Workload processes receive only a reviewed host-compatibility environment, their
explicitly stored application variables and the documented runtime contract.
Arbitrary control-plane environment variables are not inherited. This minimizes
accidental credential propagation but does not create isolation between same-user
workloads.

## Source of truth

Verified source and tests are authoritative for implemented behavior. When docs disagree with verified code, establish actual behavior from code/tests and update stale documentation in the same change.
