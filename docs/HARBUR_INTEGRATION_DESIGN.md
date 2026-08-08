# Harbur Deployment Integration

Status: implemented in the Harbur producer and Nix Ship consumer.

## Boundary

Harbur remains responsible for Google Drive storage, repository visibility, pull requests, and
merge authorization. Nix Ship never receives a Google credential, Drive file identifier, or
Harbur state document. The integration boundary is the provider-owned, versioned read API at
`/api/integrations/v1`.

Harbur records the exact uploaded repository ZIP as an immutable snapshot when a repository is
created, a GitHub mirror is refreshed, or a pull request is merged. SHA-256 content addressing
binds each revision to those exact bytes. The Drive-backed state retains immutable snapshot
metadata and an ordered `repository.snapshot` event feed with an integer cursor.

## Authorization

Public-only connections need only the Harbur origin. For private repositories and automatic merge
polling, the Harbur operator generates one random `INTEGRATION_READ_TOKEN` of at least 32
characters. An owner or administrator enters the origin and optional token once on the Nix Ship
Harbur page. Nix Ship verifies capabilities and repository access before encrypting a supplied
token with its existing AES-256-GCM master key. The token is never returned by an API or placed in
a URL.

Unauthenticated Harbur API requests can discover and download public repositories. The token is
required for private discovery/download and for the event feed. It is a read-only integration
credential, not a Drive or browser-session credential. Changing or removing it on Harbur revokes
future reads; reconnecting rotates the encrypted copy on Nix Ship. A separate secret per
repository is not used.

## Connection security

Nix Ship accepts an origin only: no embedded credentials, path, query, fragment, or cross-origin
redirect. HTTPS is mandatory for public destinations. DNS is checked before every request and
private, loopback, link-local, carrier-grade NAT, multicast and unspecified addresses are blocked
unless an owner explicitly enables private-network access for that connection. Plain HTTP is
allowed only when every resolved destination is private and that opt-in is enabled.

Responses have strict schemas and byte limits. Authorization headers and plaintext tokens are not
logged. Remote errors are bounded before parsing. Operators must still treat a private-network
opt-in as authority for that Harbur origin to receive the read token.

## Exact-revision deployment

Applications store `source_provider`, the stable Harbur repository ID and the connection ID. The
first import resolves the repository's latest immutable snapshot and queues that 64-character
SHA-256 revision. Manual redeploy resolves latest explicitly; restarts use the last deployed exact
revision.

The deployment engine downloads only the requested revision. It rejects redirects, oversized
responses and a missing or mismatched digest header, then hashes the complete compressed archive.
Extraction happens in a fresh staging directory and rejects unsafe/original path mismatches,
absolute and parent paths, symlinks and other non-regular entries, excessive entry/file/expanded
sizes, invalid CRCs, and snapshots without `flake.nix` or `flake.lock`. The staging directory is
renamed into place only after every check passes. Flake evaluation and healthy-release promotion
then use the same existing deployment engine as GitHub.

## Merge reconciliation and recovery

The Harbur reconciler polls the durable feed at `SOURCE_POLL_SECONDS`. It finds auto-deploy
applications by connection and repository ID, checks persisted deployment history for the exact
revision, and queues an unseen snapshot once. A page cursor advances only after every event in the
page has been processed. If Nix Ship is offline, it resumes from the stored cursor. If a page is
retried, the `(application, revision)` lookup prevents duplicate deployments.

Connection failures are retained as redacted status and do not affect an already running healthy
release. Cursor movement backwards is rejected. At most ten 100-event pages are consumed per
poll cycle so a large backlog cannot monopolize runtime maintenance.

## Operations

1. For private repositories or automatic merge deployment, set `INTEGRATION_READ_TOKEN` on Harbur
   and redeploy/restart it. Skip this for a public-only manual connection.
2. In Nix Ship, open **Harbur**, enter the instance origin and token, and opt into private-network
   access only for a deliberately trusted LAN instance.
3. Import a repository from the Applications dialog. Repositories without a snapshot are shown
   but cannot be selected.
4. Merge a Harbur pull request. Its exact snapshot revision appears in deployment history after
   the next source poll.
5. Before disconnecting, delete applications that reference the connection. To rotate, set the
   new token on Harbur and verify/connect the same origin again.

Harbur repositories remain trusted workload inputs. Nix evaluates and runs their flakes as the
Nix Ship host account; this integration adds provenance and transport checks, not workload
isolation.
