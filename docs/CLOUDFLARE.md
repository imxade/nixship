# Cloudflare

Cloudflare has two independent roles in Nix Ship:

1. **Automatic temporary access.** On startup, Nix Ship supervises one account-free
   Quick Tunnel for the dashboard and one for every active web deployment. No Cloudflare
   login, OAuth client, API token, domain, public IP, or router port forwarding is
   required. The dashboard and application pages show every current LAN, temporary,
   and custom-domain link as a clickable URL.
2. **Persistent custom domains.** After Cloudflare authorization, Nix Ship creates and
   supervises one named tunnel, DNS records, the dashboard hostname, and application
   ingress rules from inside the Nix Ship UI. The operator must already own a domain
   whose DNS zone is active in the authorized Cloudflare account.

Quick Tunnel and named-tunnel routes coexist. Adding `console.example.com` or
`app.example.com` does not stop the corresponding `trycloudflare.com` process.
Quick Tunnel URLs normally remain unchanged while Nix Ship and the corresponding
`cloudflared` process keep running. A graceful Nix Ship shutdown closes managed Quick
Tunnels. A crash, device reboot, process termination, or later recreation can produce
a different URL.

## Quick Tunnel operating contract

- Quick Tunnels are enabled by default. Set `QUICK_TUNNELS_ENABLED=false`
  before startup to make a node LAN/custom-domain only. Set
  `CLOUDFLARED_BIN` when `cloudflared` is not on `PATH`.
- Nix Ship uses a separate Quick Tunnel process per active web deployment. This avoids
  path-prefix rewriting and preserves normal application assumptions about `/`,
  cookies, redirects, assets, and WebSockets.
- Worker applications have no HTTP port and therefore receive no access URL.
- A deployment tunnel exists only while that deployment remains active. Retention,
  application stop, process failure, and deletion remove its tunnel state and stop
  its owned process. Startup and public-edge failures remain visible on that deployment.
- Quick Tunnel URLs are public bearer-like locations, **not authentication**.
  The Nix Ship dashboard still requires login, but hosted applications must provide
  their own authentication when they are not intended to be public.
- Cloudflare documents Quick Tunnels as development/testing access with no uptime
  guarantee, a 200 in-flight request limit, and no Server-Sent Events support.
  Nix Ship therefore polls application state and falls back to authenticated log
  snapshots when live SSE is unavailable.

The account-free command Nix Ship supervises is equivalent to:

```bash
cloudflared tunnel --config /dev/null --no-autoupdate --loglevel info \
  --output json --url http://127.0.0.1:<service-port>
```

## OAuth callback limitation

Quick Tunnels themselves do not use OAuth. Cloudflare OAuth is only for the
persistent named tunnel and DNS management. Cloudflare OAuth clients require an
exact pre-registered redirect URI, so a changing `trycloudflare.com` URL cannot be
used as a general distributor callback. The configured OAuth redirect must remain
a stable HTTPS route, a same-device loopback callback, or a distributor-operated
relay. The manual API-token connection remains available when no suitable OAuth
callback has been provisioned.

## Understand the two domain requirements

Cloudflare setup uses two different kinds of domain:

1. The **OAuth client and callback domain** is the stable route registered for
   Cloudflare authorization. It is not supplied by a Quick Tunnel.
2. The **managed zones and application hostnames** are the operator-owned domains
   Nix Ship publishes through the named tunnel, for example `example.com`,
   `console.example.com`, and `api.example.com`.

A user who does not own a domain can still use the automatic dashboard and app
Quick Tunnel URLs. A domain is required only for persistent custom hostnames.

## Step 1 — Add a domain to Cloudflare DNS

Skip this step only when the required zone is already `Active` in the selected
Cloudflare account.

1. Own a registered apex domain such as `example.com`.
2. Sign in to Cloudflare and select **Domains**.
3. Select **Onboard a domain**.
4. Enter the apex domain, not the future Nix Ship subdomain. Enter
   `example.com`, not `console.example.com`.
5. Choose the DNS-record import method and a Cloudflare plan.
6. Review every imported DNS record before changing nameservers. Cloudflare's
   scan is not guaranteed to find every web, mail or verification record.
7. If DNSSEC is enabled at the registrar, disable it before replacing the
   authoritative nameservers. Changing nameservers while the old DS record is
   active can make the domain unreachable.
8. Copy the two Cloudflare nameservers shown on the zone Overview page.
9. At the domain registrar, remove the old authoritative nameservers and add
   the Cloudflare nameservers exactly as shown.
10. Wait until Cloudflare reports the zone as **Active**. Registrar propagation
    can take up to 24 hours.
11. Re-enable DNSSEC through Cloudflare and publish the new DS information at
    the registrar when instructed.

Cloudflare's current full-zone procedure, including the DNSSEC ordering and
verification commands, is maintained in
[Set up a primary zone](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/).

Nix Ship does not register or purchase domains. It also does not migrate
existing DNS records. Complete and verify the Cloudflare zone first.

## Step 2 — Bootstrap the callback hostname

### Option A: bootstrap with a manual API token

1. Start Nix Ship on the LAN and sign in as an owner or administrator.
2. In Cloudflare, open **My Profile > API Tokens > Create Token > Custom
   token**.
3. Grant only:

   | Resource | Permission | Access |
   | --- | --- | --- |
   | Account | Cloudflare Tunnel, Cloudflare One Connectors, or Cloudflare One Connector: cloudflared | Edit/Write |
   | Zone | Zone | Read |
   | Zone | DNS | Edit/Write |

4. Restrict Account Resources to the account that will own the tunnel.
5. Restrict Zone Resources to the zones Nix Ship is allowed to manage.
6. Create the token and copy it once. Do not put it in a repository, URL or
   command history.
7. Record the account ID and zone ID from the Cloudflare account/zone Overview
   pages.
8. In Nix Ship, open **Cloudflare > Manual API token fallback**.
9. Enter the account ID, zone ID, token, a stable tunnel name such as
   `nixship`, and a dashboard hostname such as `console.example.com`.
10. Select **Save manual connection**, then **Enable tunnel**.
11. Confirm that `https://console.example.com/login` reaches Nix Ship before
    registering that URL as the OAuth callback.

Nix Ship validates the token, account/zone relationship and tunnel-list access
before replacing a working configuration. It then creates the named tunnel,
its proxied CNAME and remote ingress configuration.

### Option B: bootstrap with an existing HTTPS proxy

1. Choose a stable HTTPS hostname controlled by the operator.
2. Route it to the Nix Ship dashboard listener at
   `http://<nix-ship-lan-address>:3000`.
3. Preserve the original `Host` header and normal forwarding headers.
4. Verify the public login page and authenticated dashboard.
5. Use
   `https://<hostname>/api/cloudflare/oauth/callback` as the registered
   redirect URI.

The callback must resolve to this Nix Ship node. A documentation website with
the same publisher domain is not a substitute for the callback route.

## Step 3 — Choose a private or public OAuth client

Cloudflare creates new OAuth clients as private:

- A **private client** can be authorized only by members of its parent
  Cloudflare account. This is appropriate for a personal Nix Ship node and does
  not require publisher-domain verification.
- A **public client** can be authorized by Cloudflare users outside the parent
  account. Use this only for a distributed product. It requires a logo, client
  URL, scopes and verified publisher domain. Promotion to public visibility is
  permanent.

Without a Nix Ship-owned default domain or a distributor callback relay, one
public client cannot provide zero-touch callbacks for arbitrary operator-owned
domains. Each exact callback URI must be registered on the client. The current
repository does not implement a centralized OAuth relay. A per-node private
client is therefore the practical setup for this repository.

## Step 4 — Create the Cloudflare OAuth client

The Cloudflare account member creating the client needs Super Administrator,
Administrator or OAuth Client Write access.

1. Sign in to Cloudflare and select the account that will own the OAuth client.
2. Open **Manage Account > OAuth clients**.
3. Select **Create client**.
4. Configure these values:

   | Field | Nix Ship value |
   | --- | --- |
   | Client name | `Nix Ship` or a clearly node-specific name |
   | Client URL | A stable HTTPS page on the publisher/operator domain |
   | Response type | `code` |
   | Grant types | `authorization_code` and `refresh_token` |
   | Token endpoint authentication | `none` |
   | PKCE | Required, `S256` |
   | Redirect URI | Exact `https://console.example.com/api/cloudflare/oauth/callback` |
   | Logo | A stable HTTPS URL; required before public promotion |
   | Allowed CORS origins | Not required by Nix Ship's server-side token exchange |

5. Add the minimum API scopes needed by Nix Ship:

   - Zone Read, for active-zone discovery;
   - DNS Write/Edit, for proxied CNAME creation and ownership-checked cleanup;
   - Cloudflare Tunnel Write/Edit, or the current equivalent Cloudflare
     One/cloudflared connector write scope, for tunnel creation, token retrieval
     and remote ingress configuration.

6. If the Cloudflare scope selector offers several similarly named permissions,
   choose the scope whose underlying permission covers the documented endpoint.
   Do not grant account billing, user administration, Workers, Access-policy
   write or unrelated permissions.
7. Save the client.
8. Copy the client ID. Nix Ship's PKCE client does not use or store a client
   secret.

Cloudflare OAuth scope identifiers are current API data, not stable labels to
guess. To inspect them with a temporary administrative API token:

```bash
curl "https://api.cloudflare.com/client/v4/oauth/scopes" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" |
  jq -r '.result[] | [.id, .name, (.category // "")] | @tsv'
```

Use the returned `id` values. Cloudflare validates dot-delimited OAuth scope
IDs and rejects colon-delimited substitutes. The `openid` and `offline_access`
protocol scopes are managed automatically from the configured response and
grant types. See
[Create an OAuth client](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/),
[Create OAuth Client API](https://developers.cloudflare.com/api/resources/iam/subresources/oauth_clients/methods/create)
and
[List OAuth Scopes](https://developers.cloudflare.com/api/resources/iam/subresources/oauth_scopes/methods/list).

## Step 5 — Verify and publish a public client

Skip this step for a private, same-account client.

1. Provide the client name, HTTPS logo, client URL and scopes required by
   Cloudflare.
2. Open the client URL verification panel.
3. Copy the TXT record name and value exactly as Cloudflare displays them. The
   value includes the full `cloudflare_oauth_client_publisher=` prefix.
4. Add that TXT record to the authoritative DNS zone for the client URL's host.
5. Wait for the verification state to become **Verified**. Cloudflare polls for
   up to two days.
6. If verification expires or fails, correct the TXT record and use **Restart
   verification**. Do not change the verified client-URL domain casually:
   Cloudflare does not allow that domain to be changed after verification.
7. Review the redirect URI and scopes one more time.
8. Open the OAuth client's action menu and select **Change Visibility**.
9. Confirm public promotion only when ready. Cloudflare does not support
   changing a public client back to private.

The publisher domain, client identity and requested permissions appear on the
Cloudflare consent screen. Keep the logo, policy and client pages available.

## Step 6 — Configure Nix Ship

Cloudflare OAuth is an optional distributor feature and is disabled by default.
Enable it and set all three client values in the service environment before
starting Nix Ship:

```text
CLOUDFLARE_OAUTH_ENABLED=true
CLOUDFLARE_OAUTH_CLIENT_ID=<client ID from Cloudflare>
CLOUDFLARE_OAUTH_REDIRECT_URI=https://console.example.com/api/cloudflare/oauth/callback
CLOUDFLARE_OAUTH_SCOPES=<space-delimited exact scope IDs>
```

For example, if Cloudflare returns the IDs `scope.one`, `scope.two` and
`scope.three`, set:

```text
CLOUDFLARE_OAUTH_SCOPES=scope.one scope.two scope.three
```

Do not put human-readable permission labels, commas, JSON, colon-delimited
values or a client secret in `CLOUDFLARE_OAUTH_SCOPES`.

`PLATFORM_PUBLIC_URL` is optional. GitHub webhook routing automatically prefers the
enabled custom dashboard domain, then this explicit stable origin, then the current
dashboard Quick Tunnel URL.

The Cloudflare redirect URI and the value registered on the OAuth client must
match exactly, including scheme, host, path and port. Restart Nix Ship after
changing its process environment. The **Connect Cloudflare** button remains
unavailable until the feature switch, client ID, redirect URI and scope string
are all present. Set `CLOUDFLARE_OAUTH_ENABLED=false` to disconnect the
complete OAuth provider at one boundary. Account-free Quick Tunnels and manual
API-token named tunnels do not depend on it and continue working.

## Step 7 — Authorize and create the persistent tunnel

1. Open Nix Ship through the callback hostname and sign in as owner/admin. This
   avoids returning to a public hostname without a Nix Ship session.
2. Open **Cloudflare** from the dashboard.
3. Select **Connect Cloudflare**.
4. On Cloudflare's consent screen, verify:

   - the expected client name and publisher;
   - the intended Cloudflare account;
   - only the expected Zone, DNS and Tunnel/Connector permissions.

5. Approve access. Cloudflare redirects the browser to the registered Nix Ship
   callback.
6. Back in Nix Ship, choose an active zone. The selected zone also determines
   the Cloudflare account stored for this node.
7. Enter the tunnel name. Reuse the manual-bootstrap name to retain that
   tunnel; otherwise Nix Ship creates a new named tunnel.
8. Enter the dashboard hostname, or leave it blank when the dashboard should
   remain LAN-only.
9. Select **Create and enable tunnel**.
10. Confirm that the persistent-tunnel card reports:

    - Authorization: `Cloudflare OAuth`;
    - the expected account and zone IDs;
    - a tunnel UUID;
    - state `Running`.

11. Confirm the Cloudflare DNS record is a proxied CNAME targeting
    `<tunnel-uuid>.cfargotunnel.com`.
12. Confirm `https://console.example.com` reaches the Nix Ship login page and
    that authenticated navigation works. Live logs use SSE on normal named-tunnel
    routes and automatically use the polling fallback when needed.

Cloudflare documents the underlying route as a remote tunnel ingress entry plus
a proxied CNAME. Nix Ship performs both operations:
[Create a remote tunnel with the API](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/).

## Step 8 — Add or change the dashboard domain

1. Open **Cloudflare** in Nix Ship.
2. Find **Dashboard domain**.
3. Enter a hostname from an active zone accessible to the stored
   authorization.
4. Select **Save and sync dashboard**.
5. Verify the new DNS record, tunnel state and HTTPS login page.

To remove the public dashboard route, clear the hostname and save. Nix Ship
removes the previous DNS record only when it still targets this node's tunnel
and carries the `Managed by Nix Ship` ownership comment. It also moves the GitHub App webhook to the next available route: an explicit
`PLATFORM_PUBLIC_URL`, then the current dashboard Quick Tunnel, or the inactive
sentinel when no public route remains.

The dashboard hostname cannot also belong to a hosted application.

## Step 9 — Add a Cloudflare domain to a project

Only web applications have domain routes. Worker applications do not listen on
a web port and cannot have custom domains.

1. Ensure the application has a healthy active deployment.
2. Open **Applications**, then select the application.
3. Open the **Domains** tab.
4. In **Custom domains**, enter one hostname per line or separate hostnames
   with commas:

   ```text
   app.example.com
   api.example.net
   ```

5. Enter hostnames only. Do not include:

   - `https://` or another scheme;
   - a port;
   - a path or query string;
   - a wildcard such as `*.example.com`;
   - `localhost` or a bare single-label name.

6. Add at most 20 hostnames. A hostname can belong to only one Nix Ship
   application. Internationalized names are stored in ASCII/Punycode form.
7. Select **Save and sync domains**.
8. Read the status shown beside every hostname:

   - **Cloudflare managed:** Nix Ship found an authorized zone, synchronized the
     proxied CNAME and added the hostname to tunnel ingress.
   - **External DNS/TLS:** no authorized zone in the selected Cloudflare
     account matched. Nix Ship did not modify DNS. Configure that provider to
     reach the application's displayed stable origin port.
   - **Awaiting sync:** the route has not completed synchronization.
   - **Cloudflare not connected:** connect Cloudflare or use another DNS/TLS
     provider.
   - **Sync failed:** inspect the displayed Cloudflare error, correct the
     permission, zone or DNS conflict, and select **Sync routes** on the
     Cloudflare page.

9. In Cloudflare, confirm the managed record is a proxied CNAME targeting the
   node tunnel.
10. Test the public hostname:

    ```bash
    curl --fail --show-error --include https://app.example.com/
    ```

11. Test from a second network when practical; a LAN-only test may hide public
    DNS, Access or firewall problems.

For another zone in the same selected Cloudflare account, ensure that the OAuth
authorization or manual token includes that zone. Save the project hostname
again or select **Sync routes** after expanding access. A zone in another
Cloudflare account requires reconnecting the node to that account or treating
the hostname as externally managed.

Choose an unused hostname. Existing A, AAAA or CNAME records can conflict with
the managed tunnel CNAME and should be reviewed before synchronization.

## Step 10 — Remove a project domain

1. Open the application's **Domains** tab.
2. Remove the hostname from the text area.
3. Select **Save and sync domains**.
4. Verify that it disappears from the application's route list.
5. Verify DNS cleanup in Cloudflare.

Nix Ship deletes a record only when the record still points to this node's
tunnel and its comment is `Managed by Nix Ship`. A changed or unowned DNS record
is preserved for manual review.

## Step 11 — Protect the dashboard with Cloudflare Access

Nix Ship authentication remains mandatory, but a public administration surface
should also use Cloudflare Access.

1. Open Cloudflare Zero Trust.
2. Go to **Access controls > Applications**.
3. Add a self-hosted/public-hostname web application.
4. Enter the dashboard hostname, such as `console.example.com`.
5. Create an Allow policy restricted to the operator's identity, email address
   or trusted identity-provider group.
6. Avoid broad permanent Bypass policies.
7. Test the Access login and then the independent Nix Ship login in a private
   browser window.
8. Verify the OAuth callback while signed into Access. Cloudflare OAuth returns
   through the browser, so the operator must be able to pass the Access policy.

Application domains may be public or protected by separate, independently
scoped Access applications. Cloudflare's current model is described in
[Add web applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/)
and
[Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/).

## OAuth lifecycle and secret handling

Nix Ship generates a random ten-minute OAuth state and PKCE verifier. Only the
state hash is used for lookup; the encrypted verifier is consumed exactly once
before code exchange. Access and refresh tokens are encrypted with the node
master key. Expiring access tokens refresh under a single in-process refresh
operation, and rotated refresh tokens replace the previous encrypted value.
Tokens are never returned to the browser.

The callback does not depend on a dashboard cookie because a registered HTTPS
callback hostname can differ from the LAN hostname. Its single-use state record
binds completion to the authenticated user who started authorization. Account
and zone selection APIs still require that same authenticated owner/admin.

Cloudflare account administrators can disable public OAuth applications under
the account's public-OAuth-app access settings. An operator can revoke an
authorization from Cloudflare. Reconnect from the Nix Ship Cloudflare page when
the grant is revoked or its refresh token expires.

## Persistent route model

One named tunnel is used per node:

```text
console.example.com -> http://127.0.0.1:3000
app.example.com     -> http://127.0.0.1:<stable LAN app port>
```

Nix Ship creates proxied CNAME records targeting
`<tunnel-id>.cfargotunnel.com` and writes remotely managed ingress rules. The
tunnel starts automatically on later Nix Ship boots once the owner has enabled
it.

Nix Ship does not assign a default public hostname. The operator explicitly
chooses every dashboard and application domain.

The dashboard hostname is optional and can be added, changed or removed after
connection without re-entering credentials. A successfully synchronized
dashboard hostname also becomes the preferred GitHub webhook origin.

Multiple Cloudflare zones can share the node tunnel when the authorization can
access them. Application hostnames outside those zones are skipped—not modified
or treated as an error—so another DNS/TLS provider can proxy those domains to
the application's stable LAN port.

Each application's Domains tab and the Cloudflare page show:

- `Cloudflare managed`: DNS and remote tunnel ingress synchronized;
- `External DNS/TLS`: no authorized Cloudflare zone was found and DNS was left
  untouched;
- `Awaiting sync` or `Cloudflare not connected`: no result exists yet;
- `Sync failed`: Cloudflare returned an error, retained with the route.

Saving project domains triggers synchronization when Cloudflare is configured.
When a managed hostname is removed, Nix Ship deletes the record only if its
target is this node's tunnel and its ownership comment is `Managed by Nix Ship`.
Unrelated DNS records are never deleted.

## Failure behavior

If `cloudflared` exits, Nix Ship retries while the selected tunnel mode remains
enabled. LAN applications continue running. Route synchronization failure does
not stop or redeploy applications, and a candidate Cloudflare configuration
does not overwrite valid credentials until its access boundary is verified.

## Troubleshooting

### Connect Cloudflare is unavailable

Confirm that all three OAuth environment variables are non-empty in the
Nix Ship process environment, then restart the packaged process. Editing
`.env.example` does not configure a running service.

### Cloudflare reports an invalid redirect URI

Compare the registered URI and
`CLOUDFLARE_OAUTH_REDIRECT_URI` character for character. Check:

- `https`, not `http`, for a public callback;
- the exact hostname;
- `/api/cloudflare/oauth/callback`;
- no omitted or extra port;
- no extra trailing slash.

Also confirm that the callback hostname reaches the same Nix Ship data directory
where authorization was started. OAuth state is node-local and expires after
ten minutes.

### Cloudflare rejects the requested scopes

Fetch the current scope catalog from `GET /client/v4/oauth/scopes` and copy its
`id` values. Do not translate old API-token examples into colon-delimited OAuth
scope strings. Ensure the space-delimited Nix Ship scope set is identical to the
scope set allowed on the OAuth client.

### Authorization succeeds but no zones appear

1. Confirm the zone status is **Active**, not Pending or Moved.
2. Confirm the user authorized the intended account.
3. Confirm the client includes Zone Read.
4. For a public client, confirm the account administrator has not disabled
   public OAuth app access.
5. Reauthorize after changing client scopes or account access.

### Tunnel creation or token retrieval fails

Confirm the authorization has Cloudflare Tunnel Write/Edit or the currently
documented equivalent Cloudflare One/cloudflared connector write scope. Read
access alone can list tunnels but cannot create one or retrieve all required
runtime configuration.

### DNS synchronization fails

1. Confirm DNS Write/Edit is granted for the hostname's zone.
2. Confirm the zone belongs to the selected account.
3. Check for an existing A, AAAA or CNAME at the hostname.
4. Use a new hostname or resolve the existing record deliberately; do not
   delete unrelated production DNS blindly.
5. Select **Sync routes** after correcting access or DNS.

### The tunnel remains Starting or repeatedly reconnects

1. Inspect
   `~/.local/share/nix-platform/logs/cloudflared.log`, or the equivalent path under
   `PLATFORM_DATA_DIR`.
2. Confirm the host can make outbound connections to Cloudflare. Cloudflare's
   tunnel guide calls out port `7844` for connectivity checks.
3. Confirm system time and DNS resolution are correct.
4. Keep testing the LAN origin separately; tunnel failure must not be confused
   with application failure.

### The DNS record exists but the application returns an error

1. Confirm the application has a healthy active deployment.
2. Confirm its Domains tab reports **Cloudflare managed**.
3. Test the displayed stable LAN origin port from the Nix Ship device.
4. Check deployment logs before changing DNS.
5. Confirm Cloudflare Access is not denying the request.

### The OAuth callback is blocked by Cloudflare Access

Use the same browser to authenticate to Access before starting OAuth. The
callback is a browser redirect and does not need a broad public bypass. Ensure
the operator matches an Allow policy for the dashboard hostname.

### A grant was revoked or expired

Open the Cloudflare page and select **Reauthorize Cloudflare**. Nix Ship retains
LAN operation while public synchronization is unavailable. If the old
authorization must be removed immediately, revoke it from the Cloudflare
account's authorized-application controls and restart the connection flow.

## Official references

- [Cloudflare OAuth client registration](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/)
- [Cloudflare OAuth endpoints](https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/)
- [Cloudflare OAuth scope catalog API](https://developers.cloudflare.com/api/resources/iam/subresources/oauth_scopes/methods/list)
- [Cloudflare OAuth authorization and revocation](https://developers.cloudflare.com/fundamentals/oauth/authorizing-an-application/)
- [Cloudflare full DNS setup](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/)
- [Cloudflare remote tunnel API setup](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/)
- [Cloudflare published applications](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/)
- [Cloudflare Access web applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/)
