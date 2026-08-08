# Nix Ship

Self-hosted deployment platform for [Nix flake](https://nix.dev/concepts/flakes)
applications. Connect a GitHub or Harbur repository, pick a flake output, and deploy —
Nix Ship supervises the process, streams logs, assigns a stable LAN port, and
optionally exposes it through Cloudflare Tunnel.

## Features

- **GitHub auto-deploy** — push to your production branch, Nix Ship redeploys
  the exact commit. Branch reconciliation catches missed webhooks.
- **Harbur merge deploys** — poll durable merge events and deploy the exact
  digest-verified immutable snapshot.
- **LAN-first** — every application gets a stable port reachable at
  `http://<device-ip>:<port>` with no external dependency.
- **Quick Tunnels** — account-free temporary `trycloudflare.com` URLs for the
  dashboard and every active web deployment, shown only after the public edge
  reaches that deployment when `cloudflared` is available.
- **Release retention and promotion** — retain a global number of active releases
  per project, preview each independently, and point a configured production
  domain at any healthy retained release without rebuilding it.
- **Persistent named tunnels** — optional Cloudflare OAuth or manual API token
  connection for custom domains, DNS management and multi-zone support.
- **Encrypted secrets** — environment variables are encrypted at rest and never
  returned by APIs. Paste directly from a `.env` file.
- **Zero-downtime deploys** — the current healthy release stays routed until the
  candidate passes health checks.

## Quick start

Prerequisites: a working [Nix](https://nixos.org/download/) installation on
`x86_64-linux`, `aarch64-linux`, or `aarch64-darwin`.

```bash
nix develop
pnpm install
pnpm dev
```

Open one of the clearly marked setup URLs printed in your terminal to claim the
instance and create the owner account. Nix Ship prints the LAN URL (or a local
URL for a loopback-only binding) and also prints a Quick Tunnel URL when
`cloudflared` becomes available. The link carries the one-time claim token, so
there is no token field to copy. Creating the owner account signs you in
immediately.

## Deploy an application

1. **Connect a source** — use the GitHub App manifest flow, paste a public
   GitHub URL, or verify a Harbur instance once with its read token.
2. **Search and select** a trusted repository with a locked flake.
3. **Pick the flake output** (defaults to `apps.<system>.default`).
4. **Configure** health path and environment variables.
5. **Deploy** — Nix Ship clones, evaluates the flake, builds via `nix run`, and
   health-checks the candidate before switching traffic.

## Application contract

A web application must remain in the foreground and listen on `HOST` and `PORT`.
Mutable state belongs under `DATA_DIR`. The repository must contain `flake.nix`
and `flake.lock`.

```nix
apps.${system}.default = {
  type = "app";
  program = "${package}/bin/server";
};
```

See [`docs/DEPLOYMENT_CONTRACT.md`](docs/DEPLOYMENT_CONTRACT.md) and the
[example projects](examples/).

## Stack

- Next.js App Router, React, TypeScript strict mode
- Node.js 24, SQLite through `better-sqlite3`
- Tailwind CSS, daisyUI
- Zod validation, Server-Sent Events
- Biome (format + lint), Vitest, Playwright
- Nix, Git and cloudflared as managed executables

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Deployment contract](docs/DEPLOYMENT_CONTRACT.md)
- [Security model](docs/SECURITY.md)
- [GitHub integration](docs/GITHUB.md)
- [Cloudflare integration](docs/CLOUDFLARE.md)
- [Android and Nix-on-Droid](docs/ANDROID.md)
- [Operations](docs/OPERATIONS.md)
- [Testing](docs/TESTING.md)
- [Known limitations](docs/KNOWN_LIMITATIONS.md)
- [Harbur deployment integration](docs/HARBUR_INTEGRATION_DESIGN.md)
- [Product requirements](docs/PRD.md)
- [Specification](SPECIFICATION.md)
- [Implementation status](PROJECT_STATUS.md)

## Security

Every imported repository executes arbitrary code under the Nix Ship OS account.
Nix flakes provide reproducibility, not a security boundary. Only deploy
repositories you trust.

## License

Apache-2.0. Copyright 2026 Rituraj Basak. See `LICENSE`.
