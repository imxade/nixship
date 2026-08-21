# Implementation Status

Last updated: 2026-08-14.

## Implemented

- Workload environment inheritance is now an explicit cross-platform compatibility
  allowlist instead of a `PLATFORM_*` blacklist. Arbitrary host credentials, agent
  sockets and process-injection variables are omitted; app-configured values retain
  deterministic precedence while every runtime-owned name is reserved.
- Request and provider-response limits are enforced during streaming, sensitive
  direct administration requires a rate-limited current-password check, application
  proxies preserve trusted Cloudflare HTTPS metadata, AI lock leases renew during
  long operations, and consumed AI secret-reference ciphertext is deleted.

- Approval-gated AI control plane using AI SDK Core/UI: encrypted conversations,
  bounded read-only tool loops, capability search, strict immutable SHA-256 plans,
  actor/session/RBAC/state/version checks, sorted resource locks, deterministic
  background execution, run SSE, real deployment/model-pull progress, verification,
  cancellation of unapproved plans, current-password re-authentication and masked
  one-use secure references.
- Typed capabilities cover system/app/deployment/settings reads and mutations,
  public GitHub/Harbur source inspection and deployment, environment keys,
  lifecycle/promotion/cancellation, Cloudflare connection/domains/tunnel state,
  Harbur connections, provider profiles/defaults/probes, and multi-provider settings.
- Provider/model profiles are persisted without returning keys. Unified OpenAI-compatible
  architecture supports Ollama (local/remote), Anthropic Claude, Google Gemini, OpenAI,
  Groq, Mistral, DeepSeek, and LiteLLM Proxy. Conversation and action-planner selection
  are independent, and an exact compatibility probe keeps nonconforming models in answer-only mode.
  The composer includes a searchable model picker.
- Node.js 24 is now the consistent development, package-engine and Nix runtime
  baseline.
- TypeScript 7.0.2 and `@types/node` 26.2.0 are now the pinned compiler and Node
  API type baselines. Source and server typechecks, the production build,
  browser flows, deployment integrations and the Nix package all pass with the
  native compiler release.
- `nix develop .#ai` and `packages.ollama` supply flake-pinned Ollama for local model execution.
  Nix Ship communicates with any standard OpenAI-compatible endpoint or LiteLLM proxy.

- User-facing brand values remain centralized while runtime identifiers use the
  neutral `PLATFORM_*` contract. Old environment, data, backup, and executable
  names were removed as a deliberate clean break.
- Persisted global active-deployment retention applied independently per project,
  deterministic oldest-deployment deactivation, and preserved deployment history.
- One supervised Quick Tunnel per running web deployment, including independent
  lifecycle cleanup and deployment-specific temporary links.
- Atomic no-rebuild production promotion through the existing project proxy, with
  eligibility/race validation, an explicit production marker, and graceful
  handling when no custom domain exists.
- Clipboard controls for every displayed access URL, with URL-specific copying,
  success feedback, and non-fatal failure feedback.
- Harbur immutable SHA-256 snapshots, encrypted one-time instance connection,
  public/private discovery, exact-revision safe materialization, durable cursor polling,
  and merge-revision deployment deduplication.

- Next.js App Router dashboard, strict TypeScript APIs and one persistent custom server/runtime.
- One-time owner claim, authenticated sessions, login throttling, role enforcement and user management.
- Direct first-run LAN and available Quick Tunnel claim links, no token-entry
  field, automatic owner login, and current-password-verified self-service
  password changes that revoke other sessions.
- Fixed one-hour password-failure limits: six per source/username and 30 per source, with `Retry-After` on throttled responses.
- SQLite WAL state with forward-only, empty-database-tested migrations and encrypted stored secrets.
- Locked GitHub App manifest flow with an inactive, schema-valid LAN hook, push-only
  subscriptions, repository-selection return synchronization, paginated
  installation/repository discovery, short-lived installation tokens,
  signed/deduplicated public webhooks and LAN reconciliation.
- Omitted production branches resolve from the repository's symbolic remote `HEAD`, with a validated `main` fallback when no symbolic branch is advertised.
- Durable deployment queue with superseding/cancellation state, exact-commit Git worktrees and mandatory locked Nix flakes.
- Detached application process groups, Linux start-time/cmdline/command-hash identity checks, conservative non-Linux recovery and guarded group signalling.
- Candidate health checks, atomic route activation, current healthy release preservation and control-plane restart recovery.
- Stable per-application LAN ports plus multiple normalized custom domains, host-based HTTP routing and provider-neutral DNS/TLS support.
- Optional multi-zone Cloudflare DNS/Tunnel synchronization using one encrypted
  least-privilege API token, zone discovery, pre-save token/account/tunnel-access
  verification, per-project route status, a global case-insensitive hostname
  assignment registry, serialized ingress writes, foreign-record conflict
  protection and instance-marked cleanup of removed managed records. Apex and
  subdomain assignments are independent, while one exact hostname can belong
  to only one application or the dashboard.
- Automatic account-free Quick Tunnels for the dashboard and every web application's
  stable public port, with supervised lifecycle, strict URL parsing, simultaneous
  LAN/temporary/custom access links, public-DNS and end-to-end edge readiness
  checks before link exposure, periodic published-route checks with rotation after
  repeated edge failures, and safe cleanup before application deletion.
- Webhook-first GitHub deployment detection using custom dashboard domain, explicit
  public URL, or dashboard Quick Tunnel in that order, with periodic reconciliation
  retained as missed-delivery and route-rotation recovery.
- Simplified application controls based on actual operational state: Deploy/Redeploy
  and Stop, with internal desired-state recovery hidden from the UI. Stop cancels
  in-progress work and prevents webhook or polling restarts until manual redeploy.
- Multiline write-only dotenv-style secret entry and bounded, symlink-resistant
  deployment-log snapshot fallback when live SSE is unavailable.
- Dotenv parsing covers CRLF/BOM input, comments, quoted values, embedded equals
  signs and multiline quoted values. The deployment integration test verifies
  that a complete pasted file remains separated after encryption and reaches
  the launched application process, including valid empty assignments.
- File-backed live logs with bounded active/inactive retention.
- Verified, checksummed SQLite/application-data backup and rollback-safe restore commands.
- Locked pnpm and Nix inputs, reproducible Nix dependency hash, CI security/audit/license gates and packaged operational commands.
- A flake-backed production package plus directly deployed `hello-flake` and npm-start examples.
- A reproducible Android controller shell with Maestro/ADB/Java plus guarded
  Nix-on-Droid and Maestro acceptance scripts and a manually dispatched
  physical-runner workflow that retains evidence. First-run Maestro automation
  opens the complete claim URL and never enters a setup token manually.
- Responsive dashboard coverage across phone, tablet and desktop viewports.
- Opt-in public-GitHub acceptance automation that pushes a real commit and
  proves exact-commit healthy redeployment through the stable proxy.
- Master-only private-Harbur acceptance automation that keeps its read token out
  of pull requests and deploys a real immutable snapshot without retained artifacts.
- Apache-2.0 licensing with Rituraj Basak recorded as the owner.

## Validation completed on x86_64 Linux

The TypeScript 7.0.2 and Node 26 type-definition migration was validated on
2026-08-14:

```text
pnpm biome:ci
pnpm typecheck
pnpm test                       # 34 files, 137 tests
pnpm build
pnpm test:e2e                   # Chromium, seven scenarios
pnpm test:deployment
pnpm test:examples
pnpm db:doctor                  # 16 migrations, integrity and FK checks clean
pnpm security:check
nix flake check --print-build-logs
nix build --print-build-logs
result/bin/nixship              # fresh data, ready health response, clean SIGINT
```

The multi-deployment and Nix Ship rename work was validated on 2026-08-08:

```text
pnpm biome:ci
pnpm typecheck
pnpm test                       # 24 files, 82 tests
pnpm build
pnpm test:e2e                   # Chromium, five scenarios
pnpm test:deployment
pnpm test:examples
pnpm db:doctor                  # eight migrations, integrity and FK checks clean
pnpm security:check
nix flake check
nix build
```

The live dashboard deployment path also cloned
`https://github.com/imxade/kitsy.git`, resolved exact commit
`b99bb7b4880e76011591da1820387048bb947e14`, built and launched its locked flake,
activated the deployment, exposed a deployment-specific Quick Tunnel, and
received HTTP 200 through that public Cloudflare URL. This was host-side
acceptance evidence; Android and CI evidence is recorded separately when run.

The first-run, account-management, development-runtime and Quick Tunnel changes
were validated on 2026-07-28:

```text
pnpm biome:ci                   # 168 files
pnpm typecheck
pnpm test                       # 22 files, 71 tests
pnpm build                      # includes /account and both new auth/setup APIs
pnpm test:e2e                   # Chromium, five scenarios across four projects
pnpm test:examples              # both checked-in examples, exact commits
pnpm test:deployment
pnpm db:doctor
pnpm security:check
pnpm audit --prod --audit-level high
pnpm licenses list --prod
nix flake check                 # complete source snapshot
nix build                       # complete source snapshot, includes checks
```

The production Playwright scenario opens the token-bearing claim URL, confirms
the token field is absent, creates the owner, proves the account is already
authenticated, changes its password, signs out, rejects the old password and
signs in with the new password. It also covers the Account page at phone,
tablet and desktop widths. A second production authentication scenario repeats
the entire lifecycle with JavaScript disabled and asserts that no credential
field reaches a request URL. Startup probes proved that a missing `cloudflared`
produces only the local claim block, while cloudflared 2026.7.2 produces a
separate Quick Tunnel claim block and shuts down cleanly. A public curl to that
temporary hostname timed out from the validation host, so this run does not add
new external-edge reachability evidence. The built `result/bin/nixship`
artifact also passed the JavaScript-disabled create/change/logout/old-password
rejection/new-password login flow over the host's LAN address with no
credential-bearing request URLs.

The same run reproduced the source-development HMR failure over LAN, then
verified that the custom server completes the Next.js WebSocket upgrade and
allows the host's current LAN origin and the dashboard's strict same-origin
Quick Tunnel. The browser suite now covers this boundary in CI. A second browser
scenario forces a competing Next.js development start and proves it exits before
creating the persistent data directory or starting Quick Tunnels. It also
injects initial API failures into Applications, GitHub,
Cloudflare and System and verifies that each page stops loading, shows the
failure and offers Retry. Host-routed application WebSocket upgrades now use the
same verified proxy path as stable-port upgrades. Redundant no-op SSE handlers
and duplicated bounded request-body parsing were removed; an explicit
TypeScript unused-local/unused-parameter audit also passed.

The live `nixhost` branch of `https://github.com/imxade/kitsy.git` was deployed
at exact commit `f8371e9bbeedb080cec7680b3878898079200761`. The failure was
reproduced: `cloudflared` announced the application's hostname before that name
was usable through the public edge. With the readiness gate in place, both
dashboard and application routes remained **Preparing** until Cloudflare DNS
returned an address and the public edge reached the intended local proxy. The
Kitsy application then returned HTTP 200 through its stable LAN port and through
the normally resolved Quick Tunnel URL, the dashboard health endpoint returned
HTTP 200 through its separate Quick Tunnel, and Playwright rendered the full
application page through the public application URL. A
controlled shutdown with active upgraded browser sockets exited promptly,
stopped both tunnel process groups and released the runtime lock.

On 2026-07-28, a real dashboard paste stored six separate Kitsy variables and
the active application process received every value exactly, including spaces,
an embedded equals sign, a quoted hash, a multiline value and an empty value.
The API used `PUT` and returned key metadata without returning stored values.
Pushing Kitsy commit `f8371e9bbeedb080cec7680b3878898079200761` to the deployed
`nixhost` branch triggered the signed GitHub webhook, activated that exact commit
in about 22 seconds and superseded the previous release while the stable LAN
route remained HTTP 200. Repeated account-free edge probes also reproduced
intermittent Cloudflare timeouts with a live connector; periodic route
revalidation and automatic rotation now prevent such a hostname from remaining
indefinitely advertised as healthy. A transport comparison on the same host
returned 10/10 successful application requests over HTTP/2 and IPv4, while the
automatic IPv6/QUIC path repeatedly timed out, so managed Quick Tunnels use the
reliable transport explicitly.

The following passed on 2026-07-26 with Node.js 24.18.0, pnpm 10.34.5,
Nix 2.34.8 and cloudflared 2026.7.2:

```text
pnpm biome:ci                   # 156 files
pnpm typecheck
pnpm test                       # 18 files, 56 tests
pnpm build                      # Next.js 16.2.11 production build
pnpm test:e2e                   # Chromium, 2 scenarios, three viewport sizes
pnpm test:examples              # both checked-in examples, exact commits
pnpm test:deployment
pnpm db:doctor                  # seven migrations, integrity ok, WAL, no FK violations
pnpm security:check             # private modes and tracked-secret scan
pnpm audit --prod --audit-level high
pnpm licenses list --prod
nix flake check --print-build-logs
nix build --print-build-logs
nix flake check ./examples/hello-flake
nix build ./examples/hello-flake
nix flake check ./examples/npm-start-flake
nix build ./examples/npm-start-flake
PUBLIC_TEST_REPOSITORY_URL=https://github.com/imxade/platform-deployment-test.git \
  PUBLIC_TEST_PUSH=1 pnpm test:github-public
```

The direct-example harness copied each example into the root of its own Git repository and deployed it through the production engine without using the frontend. Both the minimal server and the npm `start` application activated at their exact commits, passed real health checks, returned through stable proxy ports and had their process groups stopped.

The real-Nix deployment integration verified healthy activation, a failing candidate preserving the active release, rapid-queue superseding, recovery of the same detached process after control-plane restart, child process-group shutdown and stable-port unavailability after stop. The current Apache-licensed `result/bin/nixship` artifact was also started with an empty isolated data directory; all seven migrations ran, `/api/health`, `/api/setup/status`, `/setup` and a traced Next.js CSS asset were served before a clean SIGINT shutdown.

The newly built package was also started against an isolated data directory with
Quick Tunnels enabled. Its dashboard health endpoint returned 200 locally and at
`https://effectiveness-information-organized-jump.trycloudflare.com`, with the
production CSP and no `unsafe-eval`. SIGINT stopped the tunnel and released the
runtime lock without leaving a child process.

Backup tests perform a real SQLite/application-data CLI round trip and reject a
checksum-tampered archive before mutating current state. Browser tests verify
first-run owner creation, setup-token invalidation, theme initialization before
body rendering, persisted theme choice, responsive alignment and absence of
overflow across authenticated routes at phone, tablet, and desktop sizes,
session cookies, hostile-origin rejection, user creation, viewer login, viewer
write denial, the separate CI admin and hourly throttle timing.

The Cloudflare unit integration verifies restricted API-token validation, zone
discovery/onboarding, candidate rollback, managed and pending per-project states,
remote ingress construction, removal of stale Nix Ship-owned DNS, and preservation
of records whose target or ownership comment does not match. It uses a
deterministic mocked Cloudflare API; it is not a live-account result.

Git reconciliation now records every observed commit, including failed
deployments, so branch polling cannot continuously retry the same broken
revision. A manual redeploy can retry a transient host failure; a repository
fix arrives as a new commit and remains automatically deployable.

The newly built `result/bin/nixship` applied migration 006 to the existing
production data directory, served a ready health response with the production
CSP and remained healthy through a complete branch-poll interval. The known
broken commit's reconciliation count and latest timestamp did not change during
that soak.

GitHub manifest tests verify that registration always supplies a syntactically
valid public hook URL, requests only the supported push event, and enables
installation setup returns. A configured `PLATFORM_PUBLIC_URL` supplies and
activates the real public webhook origin.

The public fixture
`https://github.com/imxade/platform-deployment-test.git` uses `trunk` as remote
HEAD. The acceptance test deployed
`cf80d75d88578fc9af547acf281444eb95642005`, pushed
`847ec6394705ab0810f93d21eda6ff503b0729e3`, and let the normal 15-second
background polling loop detect it. The exact revision activated after 10 seconds,
superseded the previous release and remained healthy through the stable proxy and
the unchanged application Quick URL
`https://path-babies-function-biotechnology.trycloudflare.com`.

The live private Harbur acceptance test connected to
`https://harbur.vercel.app`, discovered `rb/kitsy` only with the encrypted
integration token, matched its durable event to immutable SHA-256 revision
`6037a0c661e5dbe877cf9bba038c56c93db05f0911bff8c61f07a62ed5a9823a`,
verified and extracted the 297,063-byte snapshot, built its locked flake,
activated Kitsy, and received HTTP 200 through the stable application proxy.
The background event reconciler advanced its cursor without queuing the exact
revision twice. A secret-backed master-only CI job now repeats this read-only
gate; pull-request jobs do not receive the token and the gate uploads no artifact.

The Android development shell evaluated for `x86_64-linux`, `aarch64-linux`,
and `aarch64-darwin`. Its Maestro 2.6.1 CI login flow passed on an Android 15
x86_64 development emulator and recorded non-release evidence. The
Nix-on-Droid runner correctly rejected that non-ARM64 device.

Cloudflare persistent-domain authorization is now API-token-only. The token is
validated before encrypted storage and is independent from account-free Quick
Tunnels and LAN routing. Live zone onboarding and custom-domain acceptance
remain external release gates.

The security review reconfirmed argument-array process spawning, strict GitHub URL
and branch validation, encrypted secrets, HMAC-verified/deduplicated webhooks,
bounded webhook/log input, same-origin mutations, role checks, loopback-only
forwarded-header trust, secure forwarded-HTTPS cookies and sanitized Git
credentials. Five unused server exports and two redundant routing helpers were
removed. The production dependency audit reports no known vulnerabilities.

AI integration evidence on 2026-08-11 includes a real isolated deployment of
`https://github.com/imxade/kitsy` as `Kitsy AI GitHub E2E 20f9ed`: source inspection
preceded planning, no application existed before exact approval, the deterministic
executor built commit `693022c9f241ec15f72d5a1fc42c7e314d9359a1`, activated it,
and received HTTP 200. Flake-built Ollama 0.32.1 also passed isolated lazy
enable/readiness/process-identity/list/disable checks.

Live local-model probes were run against Qwen 2.5 3B/7B, Granite 3.3 2B/8B and
Llama 3 Groq Tool Use 8B. They answered ordinary questions and respected the tested
secret/prompt-injection boundary, but none produced the exact strict nested plan
schema required by the compatibility probe. They are therefore correctly treated
as answer-only; deterministic fake-provider tests remain the authority for control
plane correctness.

Private `rb/kitsy` passed the isolated Harbur acceptance test after its read token
was supplied process-locally and immediately converted to a scoped encrypted
one-use reference. Separate approved connection and deployment plans activated the
digest-verified snapshot as `Nix Ship AI Harbur E2E e9b17c`; the active release
returned HTTP 200. The real public fallback `rb/aunix` was correctly rejected for
missing `flake.nix`, and `rb/nixship` was correctly rejected at health activation
after binding to the machine hostname instead of its assigned loopback address.

## External and platform evidence still required

- No tested local model qualified as an action planner. Configure a stronger remote
  OpenAI-compatible model, or a future local model that passes the exact probe;
  answer-only local use remains supported.

- GitHub live-account authorization, selected-repository install, private clone
  and signed public webhook delivery are pending the owner’s test-account
  action. Public-repository branch reconciliation and push redeployment have
  passed.
- Cloudflare live API-token, zone/tunnel, Access policy, reconnect and
  custom-domain lifecycle tests have not been run against an account. Unit and
  browser coverage use deterministic mocked Cloudflare responses and cannot
  replace that evidence.
- No native `aarch64-linux`, Darwin or physical Android build was executed. Cross-platform packages in the dependency store are not evidence that those targets work.
- Android development automation passed its browser flow on an Android 15
  x86_64 emulator using the locked Maestro shell, while the Nix-on-Droid
  acceptance guard rejected that architecture as intended. The required
  two-OEM physical ARM64 matrix, Nix-on-Droid lifecycle checks and physical
  Maestro browser flows remain unexecuted.
- The plug-and-play standalone APK is a roadmap requirement for a separate Android distribution repository; no APK, signing pipeline or Android foreground-service adapter exists here.
- Deployment fixtures still needed for never-bind, immediate-exit worker, sustained high-volume logs, missing lock, wrong-system output, build-time restart, explicit cancellation and forced-termination SQLite consistency.
- Backup/log validation still needs injected disk-full/interrupted-write tests and a documented cross-node restore exercise.

## Release assessment

The x86_64 Linux source and Nix package are a validated local release candidate, but the project is **not yet generally release-ready**. Live GitHub/Cloudflare account checks, the remaining failure fixtures, native target coverage and physical ARM64 Android/Maestro gates above are mandatory before making that claim. `LOCAL_AGENT_PROMPT.md` therefore remains as the unfinished acceptance checklist. Android cannot be called production-ready until the recorded device matrix passes.
