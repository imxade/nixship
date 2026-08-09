# Cloudflare

Cloudflare has two independent roles in Nix Ship.

## Account-free Quick Tunnels

Nix Ship supervises one temporary Quick Tunnel for the dashboard and one for
each active web deployment. These routes require no Cloudflare account, token,
domain, public IP or router port forwarding.

Quick Tunnel URLs are temporary public locations, not authentication. The
dashboard still requires Nix Ship login, while hosted applications must provide
their own authentication when they are not intended to be public.

Set `QUICK_TUNNELS_ENABLED=false` before startup to disable them. Persistent
Cloudflare connection, domain changes and named-tunnel enable/disable actions do
not change Quick Tunnel rows, processes or URLs.

## Persistent custom domains

Persistent hostnames use one remotely managed Cloudflare Tunnel and a restricted
API token. Nix Ship does not support OAuth, global API keys or account
certificates.

Create a custom token with:

| Resource | Permission | Scope |
| --- | --- | --- |
| Account | Cloudflare Tunnel / Connector | Edit |
| Zone | Zone | Read |
| Zone | Zone | Edit |
| Zone | DNS | Edit |

Restrict the Account permission to the selected account. Zone permissions must
cover all zones in that account when Nix Ship is expected to create missing
zones. The token is encrypted at rest, never returned and can be revoked from
Cloudflare at any time.

In Nix Ship, open **Cloudflare**, then enter:

- Cloudflare account ID;
- restricted API token;
- a stable tunnel name, normally `nixship`;
- an optional dashboard hostname.

Nix Ship verifies the token, tunnel access and zone discovery before storing the
connection.

## Assigning a hostname in an active Cloudflare zone

1. Open the web application and select **Domains**.
2. Add an apex such as `example.com` or a subdomain such as
   `app.example.com`.
3. Save the application.
4. Nix Ship confirms that the exact hostname is not assigned elsewhere.
5. Nix Ship checks for foreign A, AAAA and CNAME records.
6. Nix Ship creates its marked CNAME, updates named-tunnel ingress and verifies
   the public route.

One exact normalized hostname can belong to only one application or the
dashboard. An apex and its children are independent assignments.

## Assigning a hostname whose apex is not on Cloudflare

For `test1.example.com`, Nix Ship derives the registrable apex `example.com`.
When that zone is absent from the connected account, Nix Ship creates a full
Cloudflare zone in pending state and displays:

- Cloudflare's assigned nameservers;
- current authoritative nameservers;
- registrar and DNSSEC guidance;
- publicly observable DNS records to preserve;
- a mandatory warning that public DNS cannot enumerate every mail,
  verification or undisclosed subdomain record.

The owner must compare every record in the existing DNS-provider dashboard and
confirm the inventory before changing nameservers. Nix Ship never edits the
registrar.

After copying Cloudflare's assigned nameservers to the registrar, use **Check
delegation**. Nix Ship keeps the assignment pending until Cloudflare reports the
zone active and public authoritative NS answers match the assigned nameservers.
It performs no tunnel DNS or ingress write before those checks pass.

### Existing Vercel or other hosting

Changing nameservers does not move hosting. Existing services continue working
when their DNS records are reproduced exactly in Cloudflare before delegation.
Start third-party A, AAAA and CNAME records as **DNS only** unless proxying is an
explicit operator decision.

Before the switch:

1. Copy all apex, subdomain, MX, TXT, CAA, SRV and verification records.
2. Disable DNSSEC at the registrar if an old DS record exists.
3. Verify the Cloudflare copy.
4. Replace the authoritative nameservers at the registrar.
5. Wait for Cloudflare to report the zone active.
6. Verify existing web and mail services.
7. Re-enable DNSSEC through Cloudflare and publish the new DS record when
   instructed.

Keep records at the old DNS provider during cache expiry. A missing record,
incorrect proxy toggle or stale DNSSEC DS record can cause an outage.

## DNS ownership and cleanup

Nix Ship refuses to overwrite a foreign A, AAAA or CNAME. Managed records carry
an instance/assignment marker and their provider record IDs are persisted.
Cleanup requires both the expected tunnel target and a recognized ownership
marker. Removing one assignment does not delete its apex zone or unrelated DNS
records.

Named-tunnel configuration writes are serialized so concurrent hostname changes
cannot discard another route.

## Why a registrar CNAME to the tunnel is insufficient

Cloudflare's `<UUID>.cfargotunnel.com` target proxies ordinary Tunnel traffic
only for DNS records in the same Cloudflare account. A CNAME created only at an
external DNS provider is therefore not the supported persistent route.

Cloudflare for SaaS and Enterprise Apex Proxying can provide a different
record-only model, but they are outside Nix Ship's self-hosted API-token design.

## Troubleshooting

### Token verification fails

Confirm that the token is active, belongs to the selected account and includes
Tunnel Edit plus Zone Read/Edit and DNS Edit. Do not use a Global API key.

### Zone remains pending

Compare the registrar's delegation with the exact two nameservers shown by Nix
Ship. Confirm that an old DNSSEC DS record is not active. Resolver caches may
continue returning the old delegation until its TTL expires.

### Domain reports a conflict

Inspect the exact hostname at the authoritative DNS provider. Nix Ship will not
replace an existing foreign A, AAAA or CNAME. Remove or deliberately migrate the
foreign record, then retry.

### Quick Tunnel still works while a domain is pending

This is expected. Temporary and persistent exposure are separate. A pending or
failed persistent hostname does not stop or rotate a Quick Tunnel.

## References

- [Cloudflare API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
- [Create Zone API](https://developers.cloudflare.com/api/resources/zones/methods/create/)
- [Full-zone setup](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/)
- [Tunnel DNS records](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/)
