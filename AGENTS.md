# Repository Engineering Guide

This is the working agreement for human and automated contributors.

## Read first

1. `SPECIFICATION.md`
2. `DECISIONS.md`
3. `PROJECT_STATUS.md`
4. `docs/SECURITY.md`
5. the affected source and tests

## Authority

Verified implementation and tests are the source of truth. Documentation explains that behavior and must be updated in the same change when behavior changes. Do not infer requirements from stale generated artifacts, old branches, or conversation exports.

## Non-negotiable constraints

- Keep the platform implementation in Next.js App Router and strict TypeScript.
- Do not introduce Go, Rust, Express, Fastify, Docker, Redis, an external database, or a separate frontend/backend without an explicit architecture decision.
- Keep Nix flakes as the only normal application build/run contract.
- Never execute user-supplied dashboard text through a shell.
- Preserve the current healthy release until a candidate is proven healthy.
- Preserve operation and optional Cloudflare exposure.
- Treat all workload repositories as trusted; never imply isolation that does not exist.
- Never fabricate successful builds, tests, compatibility, benchmark results, lock files, hashes, citations, or external integration results.

## Change discipline

- Make the smallest coherent change that fully solves the problem.
- Validate inputs at trust boundaries with Zod or an equally explicit validator.
- Pass process arguments as arrays; avoid `sh -c` and command-string interpolation.
- Use transactions for state transitions that must be atomic.
- Do not return stored secret values.
- Add or update tests for every changed state transition or security boundary.
- Keep migrations forward-only and test them from an empty database.
- Update README/spec/security/operations docs for user-visible or architectural changes.

## Required checks

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm db:doctor
pnpm security:check
nix flake check
nix build
```

Never bypass a failing check with broad `any`, `@ts-ignore`, skipped tests, disabled rules, `|| true`, or fake fixtures.

## Android work

Real Nix-on-Droid behavior must be tested on physical ARM64 devices. Keep claims evidence-based. Force stop, OEM battery killing, missing kernel capabilities, and architecture incompatibility are not fixable through a flake or Next.js alone.
