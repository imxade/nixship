# Nix Ship

Self-hosted deployment platform for [Nix flake](https://nix.dev/concepts/flakes)
applications. Connect a GitHub or Harbur repository, pick a flake output, and deploy.
Nix Ship supervises the process, streams logs, assigns a stable LAN port, and
optionally exposes it through Cloudflare Tunnel.

## Features

| Feature | Description |
| :--- | :--- |
| **GitHub auto-deploy** | Push to your production branch, Nix Ship redeploys the exact commit. Branch reconciliation catches missed webhooks. |
| **Harbur merge deploys** | Poll durable merge events and deploy the exact digest-verified immutable snapshot. |
| **LAN-first** | Every application gets a stable port reachable at `http://<device-ip>:<port>` with no external dependency. |
| **Quick Tunnels** | Account-free temporary `trycloudflare.com` URLs for the dashboard and every active web deployment, shown only after the public edge reaches that deployment when `cloudflared` is available. |
| **Release retention & promotion** | Retain a global number of active releases per project, preview each independently, and point a configured production domain at any healthy retained release without rebuilding it. |
| **Persistent named tunnels** | Optional restricted Cloudflare API-token connection for custom domains, DNS management and multi-zone support. |
| **Encrypted secrets** | Environment variables are encrypted at rest and never returned by APIs. Paste directly from a `.env` file. |
| **Zero-downtime deploys** | The current healthy release stays routed until the candidate passes health checks. |
| **Approval-gated AI assistant** | An optional OpenAI-compatible model can answer from live state and propose typed operations across applications, deployments, sources, Cloudflare, Harbur, settings and AI runtime management. Exact hash approval, RBAC, reauthentication, preconditions and deterministic verification remain outside the model. |


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

1. **Connect a source**: use the GitHub App manifest flow, paste a public
   GitHub URL, or verify a Harbur instance once with its read token.
2. **Search and select** a trusted repository with a locked flake.
3. **Pick the flake output** (defaults to `apps.<system>.default`).
4. **Configure** health path and environment variables.
5. **Deploy**: Nix Ship clones, evaluates the flake, builds via `nix run`, and
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

## AI assistant

The dashboard includes a global AI SDK assistant drawer. It can answer questions
through bounded read capabilities and can operate applications, deployments,
environment metadata, GitHub/Harbur sources, Cloudflare domains, AI providers,
model defaults, and the optional managed Ollama runtime.

The model receives role-filtered read tools as JSON-Schema function definitions and
discovers mutation descriptors through `capabilities_search`. It can return an
answer, request an input, or call `propose_plan` with the strict versioned plan
schema. Mutation implementations are never model-callable.

Plans are bound to a canonical SHA-256 hash, state snapshot, capability versions and
the authenticated human. Approval reloads the persisted plan and starts deterministic
Nix Ship code; deployment and model-download progress comes from real runtime events.
Sensitive/destructive plans require current-password re-authentication, and secure
input plaintext never enters model context; the model sees only a scoped, expiring,
one-use opaque reference. See
[`docs/AI_CONTROL_PLANE.md`](docs/AI_CONTROL_PLANE.md) for the exact model message,
tool-call, plan, approval and execution-result formats.

Public GitHub repositories are inspected first. Both `flake.nix` and `flake.lock`
must be committed; otherwise the assistant provides a starter flake and exact
lock/hash instructions instead of proposing deployment. Models must pass the
strict tool/plan compatibility probe before planning; failures remain answer-only.

Configure an OpenAI-compatible endpoint before startup:

```bash
PLATFORM_AI_BASE_URL=https://provider.example/v1
PLATFORM_AI_MODEL=model-id
PLATFORM_AI_API_KEY=... # optional for a trusted local endpoint
```

Private external endpoints, including operator-run Ollama on loopback, additionally require
`PLATFORM_AI_ALLOW_PRIVATE_NETWORK=true`. Plain HTTP is accepted only for an
explicitly enabled private endpoint. Never paste credentials into chat; use the
masked secure-input card.

For a flake-pinned local Ollama development environment, use the optional AI shell:

```bash
nix develop .#ai
ollama serve
```

In a second `nix develop .#ai` shell, pull an exact model tag, export that tag as
both `PLATFORM_AI_MODEL` and `AI_LOCAL_TEST_MODEL`, then run `pnpm test:ai-local`.
The AI shell sets the loopback endpoint, private-network opt-in and a repository-local
Ollama model directory. Ollama remains outside the base production closure; managed
Ollama is realized and started only by an approved plan.

See [`SPECIFICATION.md`](SPECIFICATION.md) for the normative platform requirements,
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the AI control-plane design, and
[`docs/OPERATIONS.md`](docs/OPERATIONS.md) for configuration and local-model probing.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [AI capability and plan protocol](docs/AI_CONTROL_PLANE.md)
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
