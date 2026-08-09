# Security Model

## Threat model

Nix Ship protects the management interface and stored credentials from unauthenticated LAN clients. It does not protect the host from a malicious deployed repository, and it does not isolate one application from another.

## Authentication

- One-time setup token generated locally and stored with mode 0600. In the
  console and UI it appears only inside the distinctive first-run LAN/Quick
  Tunnel claim URLs, not as a standalone log field or setup-form field. A valid
  claim is exchanged for a 30-minute HttpOnly, SameSite=Lax cookie before owner
  creation.
- The production command has no default username or password.
- The separate `pnpm start:ci` command binds only to loopback, recreates a
  guarded disposable data directory, and provisions the documented insecure
  browser-test admin. It must never be used for a LAN or production node.
- Passwords hashed with scrypt and per-password random salt.
- Random opaque session cookies; only token hashes are stored.
- HttpOnly, SameSite=Lax cookies; Secure when accessed over HTTPS.
- Account creation starts the owner's session. Self-service password changes
  require the current password, retain only the initiating session, and revoke
  the user's other sessions. Generic user administration cannot reset the
  protected owner password.
- Setup, login, password-change and logout forms have native same-origin POST
  behavior in addition to client-side enhancement. A missing or delayed
  JavaScript handler cannot downgrade a credential submission to GET or place
  passwords in browser history, request URLs or query logs.
- Failed logins are limited in fixed one-hour windows: six per source/username
  pair and 30 across usernames from one source. Throttled responses include
  `Retry-After`.
- Owner/admin/operator/viewer authorization checks on every write API.

## Request protection

- Mutation requests require a same-host `Origin`.
- JSON bodies have explicit size limits.
- GitHub webhook bypasses browser-origin checks but requires SHA-256 HMAC validation.
- Webhook delivery IDs are deduplicated.
- Security response headers and CSP are configured centrally.
- Development CSP permits `unsafe-eval` because the React development runtime
  requires it for debugging. Production responses exclude `unsafe-eval`; the
  production E2E suite asserts that boundary.
- Source development allows the host's current non-loopback LAN IPv4 addresses
  to request Next.js development resources and HMR upgrades. A dashboard Quick
  Tunnel HMR upgrade is accepted only when its strict `trycloudflare.com` Host
  and Origin match and the proxy connection comes from loopback. Arbitrary
  Quick Tunnel origins stay blocked. This handling exists only in development;
  application mutation origin checks remain enforced.

LAN HTTP remains readable by an attacker who can observe the local network. Use a
trusted LAN or local HTTPS. Cloudflare HTTPS protects the browser-to-edge connection
but does not change the trusted-workload model. A random `trycloudflare.com` URL is
not an authorization boundary.

## Secret storage

- Application values, GitHub private key/secret, Harbur read tokens and
  Cloudflare API/tunnel tokens are encrypted with AES-256-GCM.
- Master key comes from `PLATFORM_MASTER_KEY` or a mode-0600 local key file.
- Existing values are never sent back to the dashboard.
- Enter or rotate secrets only through an HTTPS dashboard route or a trusted private
  LAN. Plain LAN HTTP does not protect secrets in transit from observers on that
  network.
- Only an authenticated owner/admin can store or replace the restricted
  Cloudflare API token. The existing secret is never returned.
- Quick Tunnels create temporary public hostnames automatically unless disabled.
  Dashboard access still requires Nix Ship authentication. Hosted applications receive
  no automatic access control; their temporary URL must be treated as public and the
  application must implement authentication when needed.
- Next.js is prepared before the persistent runtime starts. A framework startup
  collision or initialization failure therefore cannot create detached Quick
  Tunnels that outlive an unsuccessful control-plane start.
- Persistent Cloudflare dashboard and application hostnames are explicitly supplied
  by the operator and created only in authorized zones.
- One case-insensitive assignment registry prevents an exact hostname from belonging
  to more than one application or the dashboard. Cloudflare DNS writes refuse foreign
  A, AAAA and CNAME records; cleanup requires both the expected tunnel target and this
  instance's ownership comment. Named-tunnel reconciliation is serialized and does
  not mutate Quick Tunnel rows or processes.
- Logs attempt no magical generic redaction; applications can transform or exfiltrate any secret provided to them.

For the integrated Android app, replace the local key-file fallback with Android Keystore wrapping.

## Process execution

- Executable and argument arrays are passed directly to `spawn`.
- Git credentials are supplied as process environment configuration, not embedded in repository URLs.
- Harbur credentials are Bearer headers only. Harbur origins cannot contain credentials, paths,
  queries or fragments; redirects are rejected and DNS is rechecked before each request. Public
  destinations require HTTPS, while LAN/private access and private HTTP require an explicit owner
  opt-in.
- Harbur archives are content-addressed and checked for compressed, per-file, entry-count and total
  expanded-size limits. Extraction rejects traversal, original-name sanitization, symlinks and
  non-regular entries, verifies CRC/digest, and atomically publishes only a complete locked flake.
- Applications receive a controlled working directory and explicit runtime variables.
- Each application starts in a distinct POSIX process group for group termination.

## Remaining high-priority hardening

- Add re-authentication for owner user-management and Cloudflare changes.
- Add optional local TLS and passkeys.
- Add interrupted-write and disk-full fault injection to backup/restore tests.
- Obtain independent security review before exposing the dashboard to the internet.
- Run the complete zone-onboarding and custom-domain lifecycle against a
  dedicated live Cloudflare account before release.
