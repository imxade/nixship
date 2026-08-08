import crypto from "node:crypto";
import { z } from "zod";
import type { CloudflareOAuthTokens } from "./cloudflare-oauth.ts";
import { config } from "./config.ts";
import { decryptSecret, encryptSecret, randomToken, sha256 } from "./crypto.ts";
import { getDb, nowIso } from "./db.ts";
import { HttpError } from "./errors.ts";

const API_ORIGIN = "https://api.cloudflare.com/client/v4";
const AUTHORIZATION_ENDPOINT = "https://dash.cloudflare.com/oauth2/auth";
const TOKEN_ENDPOINT = "https://dash.cloudflare.com/oauth2/token";

interface CloudflareResponse<T> {
  success: boolean;
  result: T;
  errors?: Array<{ message?: string }>;
  result_info?: { total_pages?: number };
}

interface OAuthSessionRow {
  user_id: string;
  verifier_encrypted: string;
  redirect_uri: string;
  expires_at: string;
}

interface PendingOAuthRow {
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  access_token_expires_at: string | null;
  scope: string | null;
}

interface StoredOAuthRow extends PendingOAuthRow {
  auth_method: "api_token" | "oauth";
}

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.coerce.number().int().positive().optional(),
  scope: z.string().optional(),
});

export function createCloudflareAuthorization(userId: string): string {
  const state = randomToken(32);
  const verifier = randomToken(64);
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const redirectUri = requiredConfig("CLOUDFLARE_OAUTH_REDIRECT_URI");
  const now = nowIso();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM cloudflare_oauth_sessions WHERE expires_at <= ?").run(now);
    db.prepare(
      `INSERT INTO cloudflare_oauth_sessions(
        state_hash, user_id, verifier_encrypted, redirect_uri, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(sha256(state), userId, encryptSecret(verifier), redirectUri, expiresAt, now);
  })();
  const authorization = new URL(AUTHORIZATION_ENDPOINT);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("client_id", requiredConfig("CLOUDFLARE_OAUTH_CLIENT_ID"));
  authorization.searchParams.set("redirect_uri", redirectUri);
  authorization.searchParams.set("scope", requiredConfig("CLOUDFLARE_OAUTH_SCOPES"));
  authorization.searchParams.set("state", state);
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set("code_challenge_method", "S256");
  return authorization.toString();
}

export async function completeCloudflareAuthorization(input: {
  state: string;
  code: string;
}): Promise<{ userId: string }> {
  const db = getDb();
  const session = db
    .prepare(
      `DELETE FROM cloudflare_oauth_sessions
       WHERE state_hash = ?
       RETURNING user_id, verifier_encrypted, redirect_uri, expires_at`,
    )
    .get(sha256(input.state)) as OAuthSessionRow | undefined;
  if (!session || session.expires_at <= nowIso()) {
    throw new HttpError(
      400,
      "Cloudflare authorization expired or did not originate from this session",
      "cloudflare_oauth_state_invalid",
    );
  }
  const tokens = await requestOAuthToken({
    grant_type: "authorization_code",
    client_id: requiredConfig("CLOUDFLARE_OAUTH_CLIENT_ID"),
    code: input.code,
    code_verifier: decryptSecret(session.verifier_encrypted),
    redirect_uri: session.redirect_uri,
  });
  const now = nowIso();
  db.prepare(
    `INSERT INTO cloudflare_oauth_pending(
      singleton, user_id, access_token_encrypted, refresh_token_encrypted,
      access_token_expires_at, scope, created_at, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET
      user_id = excluded.user_id,
      access_token_encrypted = excluded.access_token_encrypted,
      refresh_token_encrypted = excluded.refresh_token_encrypted,
      access_token_expires_at = excluded.access_token_expires_at,
      scope = excluded.scope,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at`,
  ).run(
    session.user_id,
    encryptSecret(tokens.accessToken),
    tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
    tokens.expiresAt,
    tokens.scope,
    now,
    now,
  );
  return { userId: session.user_id };
}

export async function cloudflareOAuthOptions(userId: string) {
  const grant = await pendingCloudflareOAuthGrant(userId);
  const [accounts, zones] = await Promise.all([
    paginatedRequest<{ id: string; name: string }>(grant.accessToken, "/accounts"),
    paginatedRequest<{
      id: string;
      name: string;
      account?: { id?: string; name?: string };
    }>(grant.accessToken, "/zones", { status: "active" }),
  ]);
  const normalizedAccounts = accounts
    .filter((account) => account.id && account.name)
    .map((account) => ({ id: account.id, name: account.name }));
  const accountNames = new Map(normalizedAccounts.map((account) => [account.id, account.name]));
  return {
    accounts: normalizedAccounts,
    zones: zones
      .filter((zone) => zone.id && zone.name && zone.account?.id)
      .map((zone) => ({
        id: zone.id,
        name: zone.name,
        accountId: zone.account?.id ?? "",
        accountName: zone.account?.name ?? accountNames.get(zone.account?.id ?? "") ?? "Cloudflare",
      })),
  };
}

export async function pendingCloudflareOAuthGrant(userId: string): Promise<CloudflareOAuthTokens> {
  const row = getDb()
    .prepare("SELECT * FROM cloudflare_oauth_pending WHERE singleton = 1 AND user_id = ?")
    .get(userId) as PendingOAuthRow | undefined;
  if (!row) {
    throw new HttpError(
      409,
      "Complete Cloudflare authorization before selecting an account and zone",
      "cloudflare_oauth_not_pending",
    );
  }
  const current = decryptedTokens(row);
  if (!shouldRefresh(current.expiresAt)) return current;
  if (!current.refreshToken) {
    throw new HttpError(
      401,
      "Cloudflare authorization expired; connect Cloudflare again",
      "cloudflare_oauth_expired",
    );
  }
  const refreshed = await refreshCloudflareOAuthToken(current.refreshToken);
  const merged = {
    ...refreshed,
    refreshToken: refreshed.refreshToken ?? current.refreshToken,
    scope: refreshed.scope ?? current.scope,
  };
  getDb()
    .prepare(
      `UPDATE cloudflare_oauth_pending SET
        access_token_encrypted = ?, refresh_token_encrypted = ?,
        access_token_expires_at = ?, scope = ?, updated_at = ?
       WHERE singleton = 1 AND user_id = ?`,
    )
    .run(
      encryptSecret(merged.accessToken),
      merged.refreshToken ? encryptSecret(merged.refreshToken) : null,
      merged.expiresAt,
      merged.scope,
      nowIso(),
      userId,
    );
  return merged;
}

export async function refreshStoredCloudflareOAuthToken(): Promise<string> {
  const current = getDb()
    .prepare(
      `SELECT auth_method, api_token_encrypted AS access_token_encrypted,
       oauth_refresh_token_encrypted AS refresh_token_encrypted,
       oauth_access_token_expires_at AS access_token_expires_at, NULL AS scope
       FROM cloudflare_config WHERE singleton = 1`,
    )
    .get() as StoredOAuthRow | undefined;
  if (current?.auth_method !== "oauth") {
    throw new HttpError(409, "Cloudflare OAuth is not configured", "cloudflare_oauth_unavailable");
  }
  const tokens = decryptedTokens(current);
  if (!shouldRefresh(tokens.expiresAt)) return tokens.accessToken;
  if (!tokens.refreshToken) {
    throw new HttpError(
      401,
      "Cloudflare authorization expired; connect Cloudflare again",
      "cloudflare_oauth_expired",
    );
  }
  const refreshed = await refreshCloudflareOAuthToken(tokens.refreshToken);
  const refreshToken = refreshed.refreshToken ?? tokens.refreshToken;
  getDb()
    .prepare(
      `UPDATE cloudflare_config SET
        api_token_encrypted = ?, oauth_refresh_token_encrypted = ?,
        oauth_access_token_expires_at = ?, updated_at = ?
       WHERE singleton = 1 AND auth_method = 'oauth'`,
    )
    .run(
      encryptSecret(refreshed.accessToken),
      encryptSecret(refreshToken),
      refreshed.expiresAt,
      nowIso(),
    );
  return refreshed.accessToken;
}

function refreshCloudflareOAuthToken(refreshToken: string): Promise<CloudflareOAuthTokens> {
  return requestOAuthToken({
    grant_type: "refresh_token",
    client_id: requiredConfig("CLOUDFLARE_OAUTH_CLIENT_ID"),
    refresh_token: refreshToken,
  });
}

async function requestOAuthToken(
  parameters: Record<string, string>,
): Promise<CloudflareOAuthTokens> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(parameters),
  });
  const body = await readJson(response);
  if (!response.ok) {
    const error = z
      .object({ error: z.string().optional(), error_description: z.string().optional() })
      .safeParse(body);
    throw new HttpError(
      502,
      error.success
        ? (error.data.error_description ?? error.data.error ?? "Cloudflare OAuth failed")
        : `Cloudflare OAuth returned HTTP ${response.status}`,
      "cloudflare_oauth_failed",
    );
  }
  const token = tokenSchema.parse(body);
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    expiresAt: token.expires_in
      ? new Date(Date.now() + token.expires_in * 1000).toISOString()
      : null,
    scope: token.scope ?? null,
  };
}

async function paginatedRequest<T>(
  accessToken: string,
  resource: string,
  query: Record<string, string> = {},
): Promise<T[]> {
  const results: T[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const search = new URLSearchParams({ ...query, page: String(page), per_page: "50" });
    const response = await fetch(`${API_ORIGIN}${resource}?${search}`, {
      signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    });
    const body = (await readJson(response)) as CloudflareResponse<T[]>;
    if (!response.ok || !body.success) {
      throw new HttpError(
        502,
        body.errors
          ?.map((error) => error.message)
          .filter(Boolean)
          .join(", ") || `Cloudflare API returned HTTP ${response.status}`,
        "cloudflare_api_failed",
      );
    }
    results.push(...body.result);
    if (!body.result_info?.total_pages || page >= body.result_info.total_pages) break;
  }
  return results;
}

function decryptedTokens(row: PendingOAuthRow): CloudflareOAuthTokens {
  return {
    accessToken: decryptSecret(row.access_token_encrypted),
    refreshToken: row.refresh_token_encrypted ? decryptSecret(row.refresh_token_encrypted) : null,
    expiresAt: row.access_token_expires_at,
    scope: row.scope,
  };
}

function shouldRefresh(expiresAt: string | null): boolean {
  return Boolean(expiresAt && Date.parse(expiresAt) <= Date.now() + 120_000);
}

function requiredConfig(
  key: "CLOUDFLARE_OAUTH_CLIENT_ID" | "CLOUDFLARE_OAUTH_REDIRECT_URI" | "CLOUDFLARE_OAUTH_SCOPES",
): string {
  const value = config[key];
  if (!value) {
    throw new HttpError(
      503,
      "Cloudflare OAuth configuration is incomplete",
      "cloudflare_oauth_unavailable",
    );
  }
  return value;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new HttpError(
      502,
      `Cloudflare returned a non-JSON HTTP ${response.status} response`,
      "cloudflare_invalid_response",
    );
  }
}
