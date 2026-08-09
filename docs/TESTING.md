# Testing Strategy

## Automated checks

```bash
pnpm biome:ci
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm test:deployment
pnpm test:examples
pnpm test:github-public             # opt-in external push test
pnpm test:harbur-private            # secret-backed external deployment test
pnpm db:doctor
pnpm security:check
pnpm audit --prod --audit-level high
pnpm licenses list --prod
nix flake check
nix build
```

The current push/pull-request CI runs the application, browser, database,
security, audit, license, direct-example, real-deployment and Nix package gates
on x86_64 Linux. Trusted pushes to `master` additionally run the private Harbur
deployment test. Pull requests never receive its integration token.

Release CI expansion still required:

- x86_64 Linux, Node 24;
- aarch64 Linux through native runner or QEMU for compile-only checks;
- macOS ARM64 for portability checks;
- Nix `flake check` and package build;
- dependency audit and secret scan.

The browser suite starts four isolated loopback servers. The normal production
command covers claim-link owner setup without token entry, automatic
authentication after account creation, current-password-verified password
change, logout, old-password rejection, new-password login, cross-origin
mutation rejection, user creation, and viewer role enforcement. The separate
`pnpm start:ci` command provisions the explicit test-only admin
`qwerty123456` / `qwerty123456`; its browser scenario verifies admin login and
the hourly authentication limit including `Retry-After`. The third production
server runs the complete create/change/logout/login lifecycle with JavaScript
disabled and fails if any password field appears in a request URL. A fourth
source-development server verifies that the custom HTTP server completes the
Next.js HMR WebSocket upgrade over both LAN and a simulated same-origin Quick
Tunnel request. Set `E2E_PORT_BASE` when the default four-port range
beginning at 3000 is already occupied.

Authenticated dashboard routes are also exercised at `320x568`, `768x1024`,
and `1440x900`. The suite checks the applications, users, GitHub, Cloudflare,
account, settings, and new-application screens for horizontal overflow and requires
exactly one visible theme control at each size. Applications, GitHub, Cloudflare
and System also receive injected initial API failures; each must stop its loading
indicator, display the failure and provide a retry action.

Cloudflare tests cover PKCE construction, hashed single-use state, callback
replay rejection, encrypted pending grants, paginated account/zone discovery,
refresh-token rotation, manual token validation, managed/external DNS states,
ownership-checked DNS cleanup and the responsive OAuth/zone-selection UI. A
mocked API result is not a live Cloudflare acceptance result.

Quick Tunnel unit coverage validates strict `trycloudflare.com` URL discovery,
rejects deceptive suffixes, and requires both public DNS and an edge response
from the intended dashboard or application proxy before making a route
available. Published routes are periodically rechecked and rotated after three
consecutive public-edge failures. The deployment integration asserts the stable
proxy readiness marker and proves that complete dotenv input survives encrypted
storage and reaches the launched process as separate exact values.
The development-runtime browser project also starts a colliding second control
plane and verifies that Next.js fails before any persistent data directory or
tunnel runtime is created. Access-link tests cover simultaneous LAN, temporary,
and custom routes. Environment tests cover multiline
dotenv-style input, duplicate keys, invalid names, quoting, and size limits.
Deployment-log tests verify bounded range/tail reads and refusal of symbolic
links on platforms supporting `O_NOFOLLOW`.

A release acceptance run must additionally start real `cloudflared` Quick Tunnels,
verify one dashboard and one per-web-app URL, confirm links remain available beside
custom domains, verify graceful shutdown closes them, verify URL rotation recovery,
and exercise the authenticated polling fallback because Quick Tunnels do not carry
Server-Sent Events.

`pnpm test:examples` bypasses the dashboard and deploys each tracked example
through the real deployment engine. The harness copies each example into the
root of an isolated Git repository, deploys its exact commit, waits for its real
health endpoint, verifies the stable proxy response, and stops its process group.

`pnpm test:github-public` is a separate opt-in external test. It requires a
dedicated repository URL and `PUBLIC_TEST_PUSH=1`, pushes a marker
commit, then waits for the background polling loop without calling reconciliation
directly. It proves that the exact pushed commit activates, the stable proxy stays
healthy, the old release is superseded, and a real application Quick Tunnel serves
the health endpoint at the same URL before and after deployment. The probe allows
for Cloudflare's initial DNS warm-up and can verify the edge through public DNS
when the test host's resolver has negatively cached the newly assigned hostname.
It must never be pointed at a repository whose history should remain untouched.

`pnpm test:harbur-private` is a read-only external acceptance test. It requires
`HARBUR_INTEGRATION_READ_TOKEN` and defaults to the private `rb/kitsy` repository
on `https://harbur.vercel.app`; `HARBUR_TEST_BASE_URL` and
`HARBUR_TEST_REPOSITORY_ID` can select a dedicated equivalent. The test connects
through the same encrypted-token service used by the dashboard, discovers the
private repository, matches its latest immutable revision with the durable event
feed, downloads and verifies the bounded snapshot, runs its real locked flake,
checks the stable application proxy, and verifies that event replay did not queue
the same revision twice. It uses an isolated data directory, disables Quick
Tunnels, stops the workload, and removes the temporary state afterward. The
master-only CI job receives the token only for this step and uploads no artifact.
The harness removes the token variable from the process environment before the
workload starts, so the deployed application cannot inherit it. The repository
remains a trusted workload: this test evaluates and executes its flake on the
runner.

The 2026-07-26 acceptance run used the public
`imxade/platform-deployment-test` fixture whose default branch is `trunk`. Normal
background reconciliation detected pushed commit
`847ec6394705ab0810f93d21eda6ff503b0729e3` within 10 seconds, activated that
exact revision and served it through the same application Quick Tunnel before
and after redeployment. This proves public-clone, default-branch discovery,
polling redeployment, stable proxy routing and live Quick Tunnel delivery; it
does not substitute for a private GitHub App installation or signed-webhook
acceptance test.

## Deployment fixtures

Test with repositories that represent:

- healthy web app;
- web app that never binds to PORT;
- health endpoint that returns 500;
- worker that exits immediately;
- app spawning child workers;
- app producing high-volume stdout/stderr;
- invalid/missing flake lock;
- flake missing current-system output;
- private GitHub repository;
- several rapid pushes;
- control-plane restart during build and while app is running.

These process/deployment cases require real Nix builds and process groups; they must not be replaced by fake success fixtures.

## Real Android gate

No Android production claim is allowed until all Phase 0 tests in the PRD pass on at least two physical ARM64 devices from different OEMs. Record Android version, Nix-on-Droid version, Nix version, device memory, battery settings and exact failures.

For the current Nix-on-Droid distribution:

1. Install and update Nix-on-Droid without granting root access.
2. Run the locked install, typecheck, unit, production build, database doctor, security check, flake check and package build commands where the device supports them.
3. Start the packaged control plane and deploy `examples/hello-flake`.
4. Run version-controlled Maestro flows against the Android browser for first-run setup, login/logout, role restrictions, GitHub authorization handoff, application creation, deployment and error states.
5. Verify access from a second LAN device and through an authenticated
   operator-owned Cloudflare hostname.
6. Exercise screen-off/wake-lock, Wi-Fi loss and recovery, Wi-Fi/mobile switching, process crash, device reboot, memory pressure, OEM battery killing and explicit Force stop.

Maestro results complement rather than replace command logs, process checks and a second-device network test. Record the Maestro and Nix-on-Droid versions, flow files, timestamps, screenshots and any device-specific exclusions. Never convert an unsupported kernel or architecture case into a passing fixture.

The future standalone APK repeats the same suite with no Nix-on-Droid or terminal precondition. Its Maestro flows must begin at fresh APK installation, cover guided configuration and verify that starting the app starts or reconnects to the foreground control-plane service and opens the web interface. Upgrade, permission denial, notification/foreground-service disclosure, backup/restore and uninstall/reinstall behavior are additional APK release gates.

The checked-in Android harness consists of:

```text
scripts/android/run-nix-on-droid.sh verify
scripts/android/run-nix-on-droid.sh serve-ci
scripts/android/run-maestro.sh ci-login
SETUP_URL='<printed setup URL>' OWNER_USERNAME=owner OWNER_PASSWORD='<password>' \
  scripts/android/run-maestro.sh first-run-setup
.github/workflows/android-device.yml
nix develop .#android
```

The manually dispatched workflow deliberately requires labeled self-hosted
physical-device runners, obtains its host tools from `nix develop .#android`,
and uploads `artifacts/android/` even when a gate fails. Physical mode rejects
non-ARM64 Nix-on-Droid hosts and Android emulators. A separately named
development-emulator mode is available for browser-flow iteration and always
marks its result as non-release evidence.

On 2026-07-24, the locked Android shell supplied Maestro 2.6.1, ADB 36.0.1,
OpenJDK 21.0.12, curl 8.21.0, and yq 4.53.3. The CI login flow passed in Chrome
on an Android 15 x86_64 development emulator against the loopback-only host
server. The Nix-on-Droid verifier correctly rejected that x86_64 emulator.
This is useful UI-development evidence, not Android compatibility or release
evidence; no physical-device pass is recorded.

APK implementation and distribution remain outside this repository. The future Android distribution repository must consume these acceptance requirements and provide its own fresh-install Maestro flows, native unit/instrumentation tests, signing/reproducibility evidence and release artifacts.

## Quality-tooling rule

Biome is the only formatter and linter. ESLint, Prettier, and framework-generated ESLint configuration must not be introduced. CI must run `pnpm biome:ci` before type checking and tests.
