# GitHub Integration

## Node-owned GitHub App

The dashboard uses GitHub's App Manifest flow so the user does not manually copy an App ID, PEM private key, client secret or webhook secret.

1. Nix Ship creates a manifest and random state.
2. Browser submits the manifest to GitHub.
3. GitHub returns a short-lived conversion code.
4. Nix Ship converts it and encrypts the returned credentials.
5. User installs the app and selects repositories.
6. Nix Ship lists installation repositories using short-lived installation tokens.

Requested repository permissions:

- metadata: read;
- contents: read;

Events:

- push;

GitHub sends the `installation` and `installation_repositories` lifecycle events
to GitHub Apps automatically; GitHub does not permit them in a manifest's
`default_events`. Nix Ship therefore requests only `push`. The manifest also sets
`setup_on_update`, so returning from GitHub after an installation or repository
selection change refreshes the complete installation list from GitHub rather
than trusting a callback query parameter.

Nix Ship uses GitHub's current `2026-03-10` REST API version, 30-second API
request deadlines, complete paginated installation/repository discovery,
encrypted App credentials, and short-lived installation tokens. The
Applications page exposes the connection action directly and searches across
every repository available to every active installation. GitHub's installation
selection remains the permission boundary; use **Manage GitHub access** to grant
the App additional repositories. HTTPS Git operations pass installation tokens
as scoped `x-access-token` HTTP Basic credentials without storing credentials in
the repository URL. The import dialog also keeps a separate **Public URL** path
for public GitHub repositories that should be cloned without App credentials.

## Webhook routing and periodic reconciliation

GitHub cannot deliver to RFC1918/LAN addresses. Nix Ship therefore selects the
webhook route in this order:

1. enabled custom Cloudflare dashboard hostname;
2. explicit `PLATFORM_PUBLIC_URL`;
3. current dashboard `trycloudflare.com` Quick Tunnel;
4. inactive `https://example.com/` sentinel when no public route exists.

When the dashboard Quick Tunnel URL changes, Nix Ship updates the GitHub App
webhook automatically. Webhook payloads are size-limited, structurally validated,
HMAC-SHA256 verified, delivery-deduplicated, branch-filtered, and converted into
durable queue records. LAN links are never registered as external webhook targets.

Periodic branch reconciliation always remains enabled, even when webhooks are
active. It recovers missed deliveries, failed delivery attempts, temporary route
changes, and time spent offline. GitHub does not automatically guarantee
redelivery of every failed webhook, so webhooks are the low-latency signal while
repository state remains the source of truth.

`PLATFORM_PUBLIC_URL` is optional and is useful when a stable public origin exists
outside the managed Cloudflare dashboard domain.

## Offline behavior

A missed webhook is recovered by branch reconciliation after the node regains internet access. Webhooks improve latency; repository state remains the eventual source of truth.

When an application is created without an explicit production branch, Nix Ship
resolves the repository's symbolic remote `HEAD`. It stores that concrete branch
name for deterministic webhook filtering and reconciliation. If the remote does
not advertise a symbolic `HEAD`, the fallback is `main`. Branch names are
validated before they enter Git refspecs.

## Public push-redeployment test

`pnpm test:github-public` is an explicitly destructive external acceptance
test. With `PUBLIC_TEST_PUSH=1`, it clones the named public test
repository, deploys its exact remote-HEAD revision, pushes a marker commit, runs
the production reconciliation code, and requires the pushed revision to become
healthy on the stable proxy while the previous release becomes superseded.

The maintained fixture is
`https://github.com/imxade/platform-deployment-test.git`, whose default branch is
`trunk`. This verifies both push-triggered redeployment and default-branch
resolution. It does not replace the live GitHub App authorization, signed
webhook, selected private repository, or missed-webhook recovery gates.
