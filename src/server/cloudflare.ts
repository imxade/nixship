import type { ChildProcess } from "node:child_process";
import { normalizeDomain } from "./app-service.ts";
import { cloudflareApiRequest } from "./cloudflare-api.ts";
import {
  type CloudflareOAuthTokens,
  cloudflareAuthorizationAccessToken,
  cloudflareOAuthStatus,
} from "./cloudflare-oauth.ts";
import { spawnLogged } from "./command.ts";
import { config } from "./config.ts";
import { decryptSecret, encryptSecret } from "./crypto.ts";
import { getDb, nowIso, setSetting, setting } from "./db.ts";
import { HttpError } from "./errors.ts";
import { logger } from "./logger.ts";
import { paths } from "./paths.ts";
import {
  captureProcessIdentity,
  matchesProcessIdentity,
  type ProcessIdentity,
} from "./process-identity.ts";
import { synchronizeGitHubWebhook } from "./public-webhook.ts";

interface CloudflareRow {
  account_id: string;
  zone_id: string;
  api_token_encrypted: string;
  tunnel_id: string | null;
  tunnel_name: string | null;
  tunnel_token_encrypted: string | null;
  dashboard_hostname: string | null;
  enabled: number;
  auth_method: "api_token" | "oauth";
  oauth_refresh_token_encrypted: string | null;
  oauth_access_token_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CloudflareDomainRoute {
  appId: string;
  appName: string;
  hostname: string;
  publicPort: number;
  status: "not-configured" | "pending" | "managed" | "external" | "error";
  zoneId: string | null;
  lastError: string | null;
  lastSyncedAt: string | null;
}

export class CloudflareController {
  private childProcess: ChildProcess | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  private processIdentity: ProcessIdentity | null = null;

  status(userId?: string): {
    configured: boolean;
    enabled: boolean;
    running: boolean;
    connectionMethod: "api_token" | "oauth" | null;
    accountId: string | null;
    zoneId: string | null;
    tunnelId: string | null;
    dashboardHostname: string | null;
    oauth: { available: boolean; pending: boolean };
    routes: CloudflareDomainRoute[];
  } {
    const row = getCloudflareConfig();
    return {
      configured: Boolean(row),
      enabled: Boolean(row?.enabled),
      running: this.isRunning(),
      connectionMethod: row?.auth_method ?? null,
      accountId: row?.account_id ?? null,
      zoneId: row?.zone_id ?? null,
      tunnelId: row?.tunnel_id ?? null,
      dashboardHostname: row?.dashboard_hostname ?? null,
      oauth: cloudflareOAuthStatus(userId),
      routes: cloudflareDomainRoutes(Boolean(row)),
    };
  }

  async configure(input: {
    accountId: string;
    zoneId: string;
    apiToken: string;
    tunnelName: string;
    dashboardHostname?: string;
  }): Promise<void> {
    await validateCloudflareAccess(input.accountId, input.zoneId, input.apiToken);
    await this.configureCredential({
      accountId: input.accountId,
      zoneId: input.zoneId,
      accessToken: input.apiToken,
      refreshToken: null,
      expiresAt: null,
      authMethod: "api_token",
      tunnelName: input.tunnelName,
      dashboardHostname: input.dashboardHostname,
    });
  }

  async configureOAuth(input: {
    accountId: string;
    zoneId: string;
    tokens: CloudflareOAuthTokens;
    tunnelName: string;
    dashboardHostname?: string;
  }): Promise<void> {
    await validateCloudflareResourceAccess(input.accountId, input.zoneId, input.tokens.accessToken);
    await this.configureCredential({
      ...input,
      accessToken: input.tokens.accessToken,
      refreshToken: input.tokens.refreshToken,
      expiresAt: input.tokens.expiresAt,
      authMethod: "oauth",
    });
    await this.enable();
  }

  async setDashboardHostname(hostname?: string): Promise<void> {
    const row = getCloudflareConfig();
    if (!row) throw new HttpError(409, "Cloudflare is not configured", "cloudflare_not_configured");
    const dashboardHostname = hostname ? normalizeDomain(hostname) : null;
    assertDashboardHostnameAvailable(dashboardHostname);
    if (dashboardHostname === row.dashboard_hostname) return;
    getDb()
      .prepare(
        "UPDATE cloudflare_config SET dashboard_hostname = ?, updated_at = ? WHERE singleton = 1",
      )
      .run(dashboardHostname, nowIso());
    try {
      await this.syncIngress();
    } catch (error) {
      if (dashboardHostname) {
        await deleteManagedDnsRecord(row, dashboardHostname).catch((cleanupError) =>
          logger.warn("Unable to remove failed dashboard DNS record", {
            error: String(cleanupError),
          }),
        );
      }
      getDb()
        .prepare(
          "UPDATE cloudflare_config SET dashboard_hostname = ?, updated_at = ? WHERE singleton = 1",
        )
        .run(row.dashboard_hostname, nowIso());
      throw error;
    }
    if (row.dashboard_hostname) await deleteManagedDnsRecord(row, row.dashboard_hostname);
    await synchronizeGitHubWebhook(true).catch((error) =>
      logger.warn("GitHub webhook URL update failed", { error: String(error) }),
    );
  }

  private async configureCredential(input: {
    accountId: string;
    zoneId: string;
    accessToken: string;
    refreshToken: string | null;
    expiresAt: string | null;
    authMethod: "api_token" | "oauth";
    tunnelName: string;
    dashboardHostname?: string;
  }): Promise<void> {
    const dashboardHostname = input.dashboardHostname
      ? normalizeDomain(input.dashboardHostname)
      : null;
    assertDashboardHostnameAvailable(dashboardHostname);
    const previous = getCloudflareConfig();
    const replaceTunnel = Boolean(
      previous &&
        (previous.account_id !== input.accountId || previous.tunnel_name !== input.tunnelName),
    );
    if (replaceTunnel) await this.stopProcess();
    const now = nowIso();
    getDb()
      .prepare(
        `INSERT INTO cloudflare_config(singleton, account_id, zone_id, api_token_encrypted, tunnel_name,
          dashboard_hostname, enabled, auth_method, oauth_refresh_token_encrypted,
          oauth_access_token_expires_at, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET account_id=excluded.account_id, zone_id=excluded.zone_id,
          api_token_encrypted=excluded.api_token_encrypted, tunnel_name=excluded.tunnel_name,
          dashboard_hostname=excluded.dashboard_hostname,
          auth_method=excluded.auth_method,
          oauth_refresh_token_encrypted=excluded.oauth_refresh_token_encrypted,
          oauth_access_token_expires_at=excluded.oauth_access_token_expires_at,
          tunnel_id=CASE WHEN account_id != excluded.account_id OR tunnel_name != excluded.tunnel_name THEN NULL ELSE tunnel_id END,
          tunnel_token_encrypted=CASE WHEN account_id != excluded.account_id OR tunnel_name != excluded.tunnel_name THEN NULL ELSE tunnel_token_encrypted END,
          updated_at=excluded.updated_at`,
      )
      .run(
        input.accountId,
        input.zoneId,
        encryptSecret(input.accessToken),
        input.tunnelName,
        dashboardHostname,
        input.authMethod,
        input.refreshToken ? encryptSecret(input.refreshToken) : null,
        input.expiresAt,
        now,
        now,
      );
    try {
      await this.ensureTunnel();
      await this.syncIngress();
    } catch (error) {
      const candidate = getCloudflareConfig();
      if (candidate && candidate.dashboard_hostname !== previous?.dashboard_hostname) {
        await deleteManagedDnsRecord(candidate, candidate.dashboard_hostname ?? "").catch(
          (cleanupError) =>
            logger.warn("Unable to remove failed candidate dashboard DNS record", {
              error: String(cleanupError),
            }),
        );
      }
      if (
        candidate?.tunnel_id &&
        (!previous?.tunnel_id || candidate.tunnel_id !== previous.tunnel_id)
      ) {
        await cleanupCandidateTunnel(candidate).catch((cleanupError) =>
          logger.warn("Unable to remove failed candidate Cloudflare tunnel", {
            error: String(cleanupError),
          }),
        );
      }
      restoreCloudflareConfig(previous);
      if (previous) {
        await this.syncIngress().catch((restoreError) =>
          logger.error("Unable to restore previous Cloudflare ingress", {
            error: String(restoreError),
          }),
        );
        if (previous.enabled && replaceTunnel) this.startProcess();
      } else {
        getDb().prepare("DELETE FROM cloudflare_domain_status").run();
      }
      throw error;
    }
    await synchronizeGitHubWebhook(true).catch((error) =>
      logger.warn("GitHub webhook URL update failed", { error: String(error) }),
    );
    if (previous?.enabled && replaceTunnel) this.startProcess();
  }

  async enable(): Promise<void> {
    await this.ensureTunnel();
    await this.syncIngress();
    getDb()
      .prepare("UPDATE cloudflare_config SET enabled = 1, updated_at = ? WHERE singleton = 1")
      .run(nowIso());
    this.startProcess();
    await synchronizeGitHubWebhook(true).catch(() => undefined);
  }

  async disable(): Promise<void> {
    getDb()
      .prepare("UPDATE cloudflare_config SET enabled = 0, updated_at = ? WHERE singleton = 1")
      .run(nowIso());
    await this.stopProcess();
    await synchronizeGitHubWebhook(true).catch(() => undefined);
  }

  async boot(): Promise<void> {
    const row = getCloudflareConfig();
    if (row?.enabled) this.startProcess();
    this.monitorTimer = setInterval(() => {
      const current = getCloudflareConfig();
      if (current?.enabled && !this.isRunning()) this.startProcess();
    }, 10_000);
    this.monitorTimer.unref();
  }

  close(): void {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
  }

  async syncIngress(): Promise<void> {
    const row = getCloudflareConfig();
    if (!row?.tunnel_id) return;
    const ingress: Array<{ hostname?: string; service: string }> = [];
    if (row.dashboard_hostname) {
      await ensureDnsRecord(row, row.dashboard_hostname, true);
      ingress.push({
        hostname: row.dashboard_hostname,
        service: `http://127.0.0.1:${config.PORT}`,
      });
    }
    const domains = getDb()
      .prepare(
        `SELECT d.hostname, d.app_id, a.public_port
         FROM application_domains d
         JOIN applications a ON a.id = d.app_id
         WHERE a.kind = 'web' AND a.public_port IS NOT NULL
         ORDER BY d.hostname`,
      )
      .all() as Array<{ hostname: string; app_id: string; public_port: number }>;
    await cleanupRemovedDomainRoutes(row, new Set(domains.map((domain) => domain.hostname)));
    for (const domain of domains) {
      const zoneId = await syncDomainRoute(row, domain);
      if (zoneId) {
        ingress.push({
          hostname: domain.hostname,
          service: `http://127.0.0.1:${domain.public_port}`,
        });
      }
    }
    ingress.push({ service: "http_status:404" });
    await cfRequest(row, `/accounts/${row.account_id}/cfd_tunnel/${row.tunnel_id}/configurations`, {
      method: "PUT",
      body: JSON.stringify({ config: { ingress } }),
    });
  }

  private async ensureTunnel(): Promise<void> {
    const row = getCloudflareConfig();
    if (!row) throw new HttpError(409, "Cloudflare is not configured", "cloudflare_not_configured");
    if (row.tunnel_id && row.tunnel_token_encrypted) return;
    const created = await cfRequest<{ id: string }>(row, `/accounts/${row.account_id}/cfd_tunnel`, {
      method: "POST",
      body: JSON.stringify({ name: row.tunnel_name || "nixship", config_src: "cloudflare" }),
    });
    const token = await cfRequest<string>(
      row,
      `/accounts/${row.account_id}/cfd_tunnel/${created.id}/token`,
    );
    getDb()
      .prepare(
        "UPDATE cloudflare_config SET tunnel_id = ?, tunnel_token_encrypted = ?, updated_at = ? WHERE singleton = 1",
      )
      .run(created.id, encryptSecret(token), nowIso());
  }

  private startProcess(): void {
    if (this.isRunning()) return;
    const row = getCloudflareConfig();
    if (!row?.tunnel_token_encrypted) throw new Error("Cloudflare tunnel token is unavailable");
    const log = `${paths.logs}/cloudflared.log`;
    const child = spawnLogged(config.CLOUDFLARED_BIN, ["tunnel", "--no-autoupdate", "run"], {
      cwd: paths.data,
      env: {
        ...process.env,
        TUNNEL_TOKEN: decryptSecret(row.tunnel_token_encrypted),
      },
      stdoutPath: log,
      stderrPath: log,
      detached: true,
    });
    if (!child.pid) throw new Error("cloudflared did not return a process ID");
    const identity = captureProcessIdentity(child.pid);
    if (!identity) {
      try {
        process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
      } catch {}
      throw new Error("Unable to establish a safe identity for cloudflared");
    }
    this.childProcess = child;
    this.processIdentity = identity;
    setSetting("cloudflared_process_identity", JSON.stringify(identity));
    child.unref();
    child.once("exit", (code, signal) => {
      logger.warn("cloudflared exited", { code, signal });
      this.childProcess = null;
      this.processIdentity = null;
      getDb().prepare("DELETE FROM settings WHERE key = 'cloudflared_process_identity'").run();
      const current = getCloudflareConfig();
      if (current?.enabled) setTimeout(() => this.startProcess(), 10_000).unref();
    });
  }

  private async stopProcess(): Promise<void> {
    const identity = this.processIdentity ?? storedCloudflaredIdentity();
    const currentChildAlive = Boolean(
      this.childProcess?.pid &&
        this.childProcess.exitCode === null &&
        identity?.pid === this.childProcess.pid,
    );
    if (identity && (currentChildAlive || matchesProcessIdentity(toStoredIdentity(identity)))) {
      try {
        process.kill(
          process.platform === "win32" ? identity.pid : -identity.processGroupId,
          "SIGTERM",
        );
      } catch {}
    }
    this.childProcess = null;
    this.processIdentity = null;
    getDb().prepare("DELETE FROM settings WHERE key = 'cloudflared_process_identity'").run();
  }

  private isRunning(): boolean {
    if (this.childProcess && this.childProcess.exitCode === null) return true;
    const identity = storedCloudflaredIdentity();
    if (identity && matchesProcessIdentity(toStoredIdentity(identity))) {
      this.processIdentity = identity;
      return true;
    }
    this.processIdentity = null;
    getDb().prepare("DELETE FROM settings WHERE key = 'cloudflared_process_identity'").run();
    return false;
  }
}

function storedCloudflaredIdentity(): ProcessIdentity | null {
  const encoded = setting("cloudflared_process_identity");
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(encoded) as ProcessIdentity;
    return Number.isSafeInteger(parsed.pid) && Number.isSafeInteger(parsed.processGroupId)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function toStoredIdentity(identity: ProcessIdentity) {
  return {
    pid: identity.pid,
    process_group_id: identity.processGroupId,
    process_start_ticks: identity.startTicks,
    process_command_hash: identity.commandHash,
    process_command_summary: identity.commandSummary,
  };
}

export function getCloudflareConfig(): CloudflareRow | null {
  return (
    (getDb().prepare("SELECT * FROM cloudflare_config WHERE singleton = 1").get() as
      | CloudflareRow
      | undefined) ?? null
  );
}

export function cloudflareDomainRoutes(configured = Boolean(getCloudflareConfig())) {
  const rows = getDb()
    .prepare(
      `SELECT d.hostname, d.app_id, a.name AS app_name, a.public_port,
        s.status, s.zone_id, s.last_error, s.last_synced_at
       FROM application_domains d
       JOIN applications a ON a.id = d.app_id
       LEFT JOIN cloudflare_domain_status s ON s.hostname = d.hostname
       WHERE a.kind = 'web' AND a.public_port IS NOT NULL
       ORDER BY a.name COLLATE NOCASE, d.hostname`,
    )
    .all() as Array<{
    hostname: string;
    app_id: string;
    app_name: string;
    public_port: number;
    status: "managed" | "external" | "error" | null;
    zone_id: string | null;
    last_error: string | null;
    last_synced_at: string | null;
  }>;
  return rows.map(
    (row): CloudflareDomainRoute => ({
      appId: row.app_id,
      appName: row.app_name,
      hostname: row.hostname,
      publicPort: row.public_port,
      status: configured ? (row.status ?? "pending") : "not-configured",
      zoneId: row.zone_id,
      lastError: row.last_error,
      lastSyncedAt: row.last_synced_at,
    }),
  );
}

async function cfRequest<T>(row: CloudflareRow, path: string, init: RequestInit = {}): Promise<T> {
  return cloudflareApiRequest<T>(await cloudflareAuthorizationAccessToken(row), path, init);
}

async function cfRequestWithToken<T>(
  apiToken: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  return cloudflareApiRequest<T>(apiToken, path, init);
}

async function validateCloudflareAccess(
  accountId: string,
  zoneId: string,
  apiToken: string,
): Promise<void> {
  const token = await cfRequestWithToken<{ status: "active" | "disabled" | "expired" }>(
    apiToken,
    "/user/tokens/verify",
  );
  if (token.status !== "active") {
    throw new HttpError(
      400,
      `Cloudflare API token is ${token.status}`,
      "cloudflare_token_inactive",
    );
  }
  await validateCloudflareResourceAccess(accountId, zoneId, apiToken);
}

async function validateCloudflareResourceAccess(
  accountId: string,
  zoneId: string,
  apiToken: string,
): Promise<void> {
  const zone = await cfRequestWithToken<{ id: string; account?: { id?: string } }>(
    apiToken,
    `/zones/${encodeURIComponent(zoneId)}`,
  );
  if (zone.id !== zoneId || zone.account?.id !== accountId) {
    throw new HttpError(
      400,
      "The Cloudflare zone does not belong to the configured account",
      "cloudflare_zone_account_mismatch",
    );
  }
  await cfRequestWithToken(
    apiToken,
    `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel?per_page=1&is_deleted=false`,
  );
}

function assertDashboardHostnameAvailable(hostname: string | null): void {
  if (
    hostname &&
    getDb().prepare("SELECT 1 FROM application_domains WHERE hostname = ?").get(hostname)
  ) {
    throw new HttpError(
      409,
      "The dashboard hostname is already assigned to an application",
      "domain_already_assigned",
    );
  }
}

function restoreCloudflareConfig(row: CloudflareRow | null): void {
  if (!row) {
    getDb().prepare("DELETE FROM cloudflare_config WHERE singleton = 1").run();
    return;
  }
  getDb()
    .prepare(
      `UPDATE cloudflare_config SET
        account_id = ?, zone_id = ?, api_token_encrypted = ?, tunnel_id = ?,
        tunnel_name = ?, tunnel_token_encrypted = ?, dashboard_hostname = ?,
        enabled = ?, auth_method = ?, oauth_refresh_token_encrypted = ?,
        oauth_access_token_expires_at = ?, created_at = ?, updated_at = ?
       WHERE singleton = 1`,
    )
    .run(
      row.account_id,
      row.zone_id,
      row.api_token_encrypted,
      row.tunnel_id,
      row.tunnel_name,
      row.tunnel_token_encrypted,
      row.dashboard_hostname,
      row.enabled,
      row.auth_method,
      row.oauth_refresh_token_encrypted,
      row.oauth_access_token_expires_at,
      row.created_at,
      row.updated_at,
    );
}

async function cleanupCandidateTunnel(row: CloudflareRow): Promise<void> {
  if (!row.tunnel_id) return;
  const domains = getDb()
    .prepare("SELECT hostname FROM application_domains ORDER BY hostname")
    .all() as Array<{ hostname: string }>;
  for (const { hostname } of domains) await deleteManagedDnsRecord(row, hostname);
  await cfRequest(
    row,
    `/accounts/${encodeURIComponent(row.account_id)}/cfd_tunnel/${encodeURIComponent(row.tunnel_id)}`,
    { method: "DELETE" },
  );
}

async function ensureDnsRecord(
  row: CloudflareRow,
  hostname: string,
  required: boolean,
): Promise<string | null> {
  if (!row.tunnel_id) return null;
  const zoneId = await zoneForHostname(row, hostname);
  if (!zoneId) {
    if (required) {
      throw new HttpError(
        400,
        `Cloudflare cannot manage DNS for ${hostname}; grant this token access to that zone`,
        "cloudflare_zone_not_found",
      );
    }
    logger.info("Skipping externally managed application domain during Cloudflare sync", {
      hostname,
    });
    return null;
  }
  const query = await cfRequest<Array<{ id: string; content: string }>>(
    row,
    `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`,
  );
  const data = {
    type: "CNAME",
    name: hostname,
    content: `${row.tunnel_id}.cfargotunnel.com`,
    proxied: true,
    ttl: 1,
    comment: "Managed by Nix Ship",
  };
  if (query[0]) {
    await cfRequest(row, `/zones/${zoneId}/dns_records/${query[0].id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  } else {
    await cfRequest(row, `/zones/${zoneId}/dns_records`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }
  return zoneId;
}

async function syncDomainRoute(
  row: CloudflareRow,
  domain: { hostname: string; app_id: string },
): Promise<string | null> {
  try {
    const zoneId = await ensureDnsRecord(row, domain.hostname, false);
    recordDomainStatus(domain.hostname, domain.app_id, zoneId ? "managed" : "external", zoneId);
    return zoneId;
  } catch (error) {
    recordDomainStatus(
      domain.hostname,
      domain.app_id,
      "error",
      null,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

function recordDomainStatus(
  hostname: string,
  appId: string,
  status: "managed" | "external" | "error",
  zoneId: string | null,
  lastError: string | null = null,
): void {
  getDb()
    .prepare(
      `INSERT INTO cloudflare_domain_status(
        hostname, app_id, status, zone_id, last_error, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(hostname) DO UPDATE SET
        app_id = excluded.app_id,
        status = excluded.status,
        zone_id = excluded.zone_id,
        last_error = excluded.last_error,
        last_synced_at = excluded.last_synced_at`,
    )
    .run(hostname, appId, status, zoneId, lastError, nowIso());
}

async function cleanupRemovedDomainRoutes(
  row: CloudflareRow,
  activeHostnames: Set<string>,
): Promise<void> {
  const stale = getDb()
    .prepare("SELECT hostname, status FROM cloudflare_domain_status ORDER BY hostname")
    .all() as Array<{ hostname: string; status: "managed" | "external" | "error" }>;
  for (const route of stale) {
    if (activeHostnames.has(route.hostname)) continue;
    if (route.status === "managed") await deleteManagedDnsRecord(row, route.hostname);
    getDb().prepare("DELETE FROM cloudflare_domain_status WHERE hostname = ?").run(route.hostname);
  }
}

async function deleteManagedDnsRecord(row: CloudflareRow, hostname: string): Promise<void> {
  if (!row.tunnel_id || !hostname) return;
  const zoneId = await zoneForHostname(row, hostname);
  if (!zoneId) return;
  const records = await cfRequest<Array<{ id: string; content: string; comment?: string | null }>>(
    row,
    `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`,
  );
  const expectedContent = `${row.tunnel_id}.cfargotunnel.com`;
  for (const record of records) {
    if (
      record.content !== expectedContent ||
      !["Managed by Nix Ship", "Managed by Nix Ship"].includes(record.comment ?? "")
    ) {
      continue;
    }
    await cfRequest(row, `/zones/${zoneId}/dns_records/${record.id}`, { method: "DELETE" });
  }
}

async function zoneForHostname(row: CloudflareRow, hostname: string): Promise<string | null> {
  const configured = await cfRequest<{ id: string; name: string }>(row, `/zones/${row.zone_id}`);
  if (hostname === configured.name || hostname.endsWith(`.${configured.name}`)) {
    return configured.id;
  }

  const labels = hostname.split(".");
  for (let index = 0; index <= labels.length - 2; index++) {
    const candidate = labels.slice(index).join(".");
    const zones = await cfRequest<Array<{ id: string; name: string }>>(
      row,
      `/zones?account.id=${encodeURIComponent(row.account_id)}&name=${encodeURIComponent(candidate)}&status=active&per_page=1`,
    );
    if (zones[0]) return zones[0].id;
  }
  return null;
}
