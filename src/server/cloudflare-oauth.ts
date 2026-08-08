import { config } from "./config.ts";
import { decryptSecret } from "./crypto.ts";
import { getDb } from "./db.ts";
import { HttpError } from "./errors.ts";

export interface CloudflareOAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scope: string | null;
}

export interface StoredCloudflareAuthorization {
  auth_method: "api_token" | "oauth";
  api_token_encrypted: string;
  oauth_refresh_token_encrypted: string | null;
  oauth_access_token_expires_at: string | null;
}

let refreshPromise: Promise<string> | null = null;

export function cloudflareOAuthStatus(userId?: string): {
  available: boolean;
  pending: boolean;
} {
  const available = cloudflareOAuthAvailable();
  const pending =
    available && userId
      ? getDb()
          .prepare("SELECT 1 FROM cloudflare_oauth_pending WHERE singleton = 1 AND user_id = ?")
          .get(userId)
      : undefined;
  return { available, pending: Boolean(pending) };
}

export async function createCloudflareAuthorization(userId: string): Promise<string> {
  assertCloudflareOAuthAvailable();
  return (await provider()).createCloudflareAuthorization(userId);
}

export async function completeCloudflareAuthorization(input: {
  state: string;
  code: string;
}): Promise<{ userId: string }> {
  assertCloudflareOAuthAvailable();
  return (await provider()).completeCloudflareAuthorization(input);
}

export async function cloudflareOAuthOptions(userId: string) {
  assertCloudflareOAuthAvailable();
  return (await provider()).cloudflareOAuthOptions(userId);
}

export async function pendingCloudflareOAuthGrant(userId: string): Promise<CloudflareOAuthTokens> {
  assertCloudflareOAuthAvailable();
  return (await provider()).pendingCloudflareOAuthGrant(userId);
}

export function clearPendingCloudflareOAuthGrant(userId: string): void {
  getDb()
    .prepare("DELETE FROM cloudflare_oauth_pending WHERE singleton = 1 AND user_id = ?")
    .run(userId);
}

export async function cloudflareAuthorizationAccessToken(
  row: StoredCloudflareAuthorization,
): Promise<string> {
  if (
    row.auth_method !== "oauth" ||
    !row.oauth_access_token_expires_at ||
    Date.parse(row.oauth_access_token_expires_at) > Date.now() + 120_000
  ) {
    return decryptSecret(row.api_token_encrypted);
  }
  assertCloudflareOAuthAvailable(
    "Cloudflare OAuth refresh is disabled; reconnect the named tunnel with a manual API token",
  );
  if (!refreshPromise) {
    refreshPromise = provider()
      .then((module) => module.refreshStoredCloudflareOAuthToken())
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

function cloudflareOAuthAvailable(): boolean {
  return Boolean(
    config.CLOUDFLARE_OAUTH_ENABLED &&
      config.CLOUDFLARE_OAUTH_CLIENT_ID &&
      config.CLOUDFLARE_OAUTH_REDIRECT_URI &&
      config.CLOUDFLARE_OAUTH_SCOPES,
  );
}

function assertCloudflareOAuthAvailable(
  message = "Cloudflare OAuth is disabled or incomplete on this Nix Ship distribution",
): void {
  if (!cloudflareOAuthAvailable()) {
    throw new HttpError(503, message, "cloudflare_oauth_unavailable");
  }
}

function provider() {
  return import("./cloudflare-oauth-provider.ts");
}
