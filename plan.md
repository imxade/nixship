# Cloudflare Domain Assignment Implementation Plan

## Outcome

Give a self-hosted Nix Ship node a practical domain flow without OAuth or any
Nix Ship-operated public gateway:

1. An owner creates one least-privilege Cloudflare API token and connects an
   account to Nix Ship.
2. An owner assigns an apex or subdomain to exactly one application or to the
   dashboard.
3. Nix Ship determines the registrable apex and checks whether its Cloudflare
   zone exists and is active.
4. If the zone is absent, Nix Ship creates a full Cloudflare zone, persists its
   assigned nameservers and pauses the hostname before any tunnel DNS record is
   created.
5. Nix Ship shows exact registrar instructions and a record-preservation
   checklist. The owner copies the Cloudflare nameservers to the registrar.
6. Nix Ship verifies public NS delegation and Cloudflare's zone status.
7. Only after activation does Nix Ship create the owned tunnel CNAME, publish
   exact ingress and verify HTTPS routing.

Cloudflare is optional. LAN access and account-free Quick Tunnels retain their
current schema, processes, readiness checks, URLs and lifecycle.

## Execution status

Done in this branch:

- [x] Removed Cloudflare OAuth routes, OAuth server code, OAuth tests and OAuth
      connection UI.
- [x] Switched the live Cloudflare connection model to an encrypted
      API-token-only account connection.
- [x] Added token/account/tunnel-access validation before saving Cloudflare
      credentials.
- [x] Removed primary-zone-ID configuration from the connection flow; zones are
      discovered or onboarded per assigned hostname.
- [x] Added registrable-apex derivation through the Public Suffix List.
- [x] Added `domain_zones` onboarding state for discovered, pending-delegation,
      active and error zones.
- [x] Added missing-apex handling that creates a full Cloudflare zone and pauses
      route provisioning until nameserver delegation and inventory confirmation
      are complete.
- [x] Added registrar-oriented UI for assigned nameservers, observed
      nameservers, observed apex records and inventory confirmation.
- [x] Added a unified hostname assignment registry where apexes and subdomains
      are independent, but exact normalized hostnames are globally exclusive
      across dashboard and applications.
- [x] Added Cloudflare DNS conflict protection for foreign A, AAAA and CNAME
      records.
- [x] Added instance/assignment ownership comments and persisted DNS/tunnel IDs
      so cleanup only removes DNS that this node owns.
- [x] Kept removed managed application domains in `removing` state until
      Cloudflare cleanup can prove deletion.
- [x] Removed the live `cloudflare_domain_status` read model after migrating
      route status to assignment/zone state.
- [x] Updated docs, specification, decisions, operations, security, testing and
      known-limitations text to match the selected API-token architecture.
- [x] Preserved Quick Tunnel behavior; persistent custom-domain assignment does
      not start, stop, rotate or mutate Quick Tunnel rows/processes.
- [x] Updated the pnpm/Nix dependency hash after adding `tldts`.

Validation completed on 2026-08-09:

- [x] `pnpm biome:ci`
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`
- [x] `pnpm test:e2e`
- [x] `pnpm db:doctor`
- [x] `pnpm security:check`
- [x] `nix flake check --print-build-logs`
- [x] `nix build --print-build-logs`

Not marked done:

- [ ] Live Cloudflare registrar acceptance with a real unused domain/subdomain.
      This requires a real Cloudflare API token, registrar nameserver changes
      when onboarding a missing apex, and cleanup after verification. Do not
      record this as complete until the live domain actually reaches the target
      Nix Ship route.

## Deliberate product decisions

- Use a restricted API token, not OAuth, SSO, a global API key, `cert.pem`, or a
  Nix Ship callback relay.
- The connection form accepts the API token and Cloudflare account ID. After
  validation, Nix Ship discovers zones; it never asks for a primary zone ID.
- Required token permissions:
  - Account / Cloudflare Tunnel / Edit;
  - Zone / Zone / Read;
  - Zone / Zone / Edit, so missing full zones can be created;
  - Zone / DNS / Edit;
  - zone permissions scoped to all zones in the selected account, including
    zones created after the token.
- Each normalized hostname is independent. `example.com` and
  `api.example.com` may belong to different targets, but one exact hostname may
  belong to only one target on the node.
- A single apex cannot route to multiple applications. Use separate apexes or
  separate subdomains.
- A subdomain whose apex is not on Cloudflare triggers apex-zone onboarding.
  Nix Ship does not attempt to create a standalone child zone.
- Changing nameservers is the only supported ordinary-Tunnel path for a domain
  whose DNS is currently external. Cloudflare for SaaS, partial zones and
  Enterprise Apex Proxying are out of scope.
- Nix Ship never changes nameservers at a registrar. It shows the exact values
  and verifies the result.
- Zone creation is not route activation. A pending zone cannot receive a
  Nix Ship tunnel record or be advertised as accessible.
- Existing public DNS is never silently replaced. The owner must confirm a
  pre-cutover inventory before Nix Ship considers the zone ready for delegation.
- Existing foreign A, AAAA and CNAME records are conflicts. Nix Ship never
  overwrites, adopts or deletes them.
- Managed records carry an opaque instance/assignment marker and their provider
  resource IDs are persisted.
- No backward compatibility is required for the removed OAuth routes, OAuth
  environment variables, legacy Cloudflare response shapes, old connection UI,
  or obsolete Cloudflare status tables. Database changes remain forward-only.

## State model

### Provider connection

One Cloudflare connection per node for this implementation:

```text
cloudflare_connection
  account_id
  api_token_encrypted
  tunnel_id
  tunnel_name
  tunnel_token_encrypted
  enabled
  created_at
  updated_at
```

The API never returns the stored token or tunnel token.

### Zone onboarding

```text
domain_zones
  apex
  cloudflare_zone_id
  state                    discovered | pending-delegation | active | error
  assigned_nameservers     JSON array
  observed_nameservers     JSON array
  original_nameservers     JSON array
  inventory_confirmed_at
  activated_at
  last_checked_at
  last_error
  created_at
  updated_at
```

Zone activation requires both:

- Cloudflare reports the zone as `active`; and
- public authoritative NS answers match the assigned Cloudflare nameservers.

### Hostname assignment

```text
domain_assignments
  hostname                 case-insensitive primary key
  apex
  target_type              dashboard | application
  app_id
  state                    waiting-zone | provisioning | verifying | active |
                           conflict | error
  zone_id
  dns_record_id
  tunnel_id
  ownership_marker
  last_error
  verified_at
  created_at
  updated_at
```

Assignments remain `waiting-zone` while their apex is absent, pending or not
publicly delegated. They do not enter named-tunnel ingress until active.

## Missing-apex flow

For an assignment such as `test1.riturajbasak.tech`:

1. Normalize the hostname and derive `riturajbasak.tech` with a Public Suffix
   List implementation; do not assume the last two labels are always the apex.
2. Query accessible Cloudflare zones by exact apex.
3. When absent, create a full zone in the connected account.
4. Persist the returned zone ID, pending state, assigned nameservers, original
   registrar and original nameservers.
5. Query public DNS for common apex records and show them only as an advisory
   inventory. DNS cannot enumerate every record, so the owner must compare the
   existing provider dashboard and explicitly confirm the complete inventory.
6. Display:
   - the registrar, when Cloudflare reports it;
   - the current authoritative nameservers;
   - the two assigned Cloudflare nameservers;
   - DNSSEC ordering and a warning not to switch with an old DS record active;
   - known A/AAAA/CNAME/MX/TXT/CAA records to preserve;
   - an explicit warning that mail and undiscovered subdomains may exist.
7. Poll manually on demand and periodically for zone status plus public NS
   delegation.
8. Once active, run DNS conflict preflight, create the owned CNAME, update the
   serialized tunnel ingress and verify HTTPS reaches the intended local target.

If zone creation is denied, retain the assignment in an error state and explain
that the token needs Zone Edit for all zones in the selected account. Never
fall back to an external `cfargotunnel.com` CNAME because it will not proxy an
ordinary Tunnel outside the owning Cloudflare account.

## Registrar and existing-hosting safety

- Cloudflare's import/scan is not treated as complete.
- Nix Ship does not promise zero downtime from an unverified DNS migration.
- Existing records should initially remain DNS-only unless the operator
  explicitly chooses Cloudflare proxying for that service.
- The UI blocks the “I copied every record” confirmation until it has shown the
  migration warning, but the confirmation remains an operator assertion because
  arbitrary DNS zones cannot be enumerated from outside.
- DNSSEC must be disabled at the registrar before delegation if an old DS record
  exists, then re-enabled through Cloudflare after activation.
- Old provider records should remain intact during nameserver cache expiry.
- Removing an assignment removes only its marked CNAME and ingress rule. It does
  not delete the apex zone or unrelated DNS records.
- Deleting a Cloudflare connection must not delete zones, foreign DNS records or
  tunnels unless a separate destructive action names the exact managed resource.

## Cleanup mandate

Remove code made redundant by the selected architecture:

- all Cloudflare OAuth source files, API routes, UI, tests and configuration;
- OAuth session/pending tables through a forward-only cleanup migration;
- `auth_method`, refresh-token and OAuth-expiry fields from the live connection
  schema;
- the “manual fallback” terminology—the API token is the only connection path;
- configured-primary-zone assumptions and required zone-ID input;
- `cloudflare_domain_status` after assignment/zone state becomes the sole read
  model;
- duplicate dashboard/application collision checks outside the assignment
  service;
- legacy response fields and documentation retained only for compatibility;
- dead environment variables, types, exports, components and tests discovered
  by `rg`, TypeScript, Biome and the production build.

Do not remove or refactor Quick Tunnel code as incidental cleanup.

## Mergeable delivery sequence

### PR 1 — API-token-only Cloudflare boundary

- Remove OAuth and its routes/configuration/UI/tests.
- Replace the singleton configuration with the minimal API-token connection.
- Validate the token, account and required tunnel access before storing it.
- Discover zones instead of accepting a primary zone ID.
- Add the forward-only cleanup migration and update docs/tests.

Merge gate: token connection works with deterministic API tests; secrets are
write-only; Quick Tunnel tests are unchanged and passing.

### PR 2 — Zone onboarding

- Add `domain_zones` and registrable-apex derivation.
- Create missing full zones through the Cloudflare API.
- Persist assigned/original nameservers and pending state.
- Add inventory confirmation and public NS/Cloudflare activation checks.
- Expose precise registrar instructions through authenticated APIs and UI.

Merge gate: assigning a subdomain with no apex zone returns pending registrar
instructions and performs no tunnel DNS or ingress write.

### PR 3 — Transactional hostname provisioning

- Complete the unified assignment state machine.
- Preflight exact DNS records and enforce global hostname uniqueness.
- Persist DNS record IDs plus instance/assignment ownership markers.
- Serialize tunnel configuration writes.
- Verify DNS, TLS and target routing before exposing the custom-domain URL.
- Implement retry, rollback and ownership-proven removal.
- Remove `cloudflare_domain_status` and remaining old reads.

Merge gate: apex and subdomain routes activate independently; foreign records
remain untouched; failures retain healthy app and dashboard routes.

### PR 4 — Operational completion and live acceptance

- Finish responsive UI states and no-JavaScript form behavior.
- Add DNSSEC, Vercel-preservation, mail-record and rollback guidance.
- Update specification, decisions, security, operations, backup and restore docs.
- Run a live unused-subdomain test followed by cleanup.
- Capture Quick Tunnel coexistence evidence.

Merge gate: documented live evidence matches behavior and no credentials or
fabricated provider results enter the repository.

Each PR must be independently reviewable, migration-safe and green before it is
merged. Do not mix unrelated formatting or the user's existing worktree changes
into these commits.

## Required validation for every affected PR

```bash
pnpm biome:ci
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm db:doctor
pnpm security:check
nix flake check
nix build
```

Also run the public-GitHub/Kitsy deployment path when deployment behavior is
touched. Android claims still require physical ARM64 testing.

## Acceptance criteria

- API token is the only persistent Cloudflare authorization path.
- No OAuth route, setting, table, component or documentation remains.
- User can assign an apex or subdomain to one target.
- Exact hostname collisions fail atomically across apps and dashboard.
- Missing apex zone is created automatically and remains pending.
- Exact Cloudflare nameservers and registrar instructions are visible without
  returning the stored token.
- No DNS/tunnel route is created before zone activation and delegation match.
- Existing hosting records are preserved through explicit inventory review.
- Foreign DNS records are never overwritten or deleted.
- Active routes are publicly verified before being advertised.
- Quick Tunnel behavior and state remain unaffected.

## Primary references

- Cloudflare Create Zone API:
  https://developers.cloudflare.com/api/resources/zones/methods/create/
- Cloudflare full-zone setup:
  https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/
- Cloudflare Tunnel DNS routing:
  https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/
- Cloudflare API token guidance:
  https://developers.cloudflare.com/fundamentals/api/get-started/create-token/
