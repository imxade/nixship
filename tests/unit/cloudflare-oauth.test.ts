import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "platform-cloudflare-oauth-test-"));
process.env.PLATFORM_DATA_DIR = dataDirectory;
process.env.PLATFORM_MASTER_KEY = Buffer.alloc(32, 21).toString("base64");
process.env.CLOUDFLARE_OAUTH_CLIENT_ID = "cloudflare-public-client";
process.env.CLOUDFLARE_OAUTH_REDIRECT_URI = "http://127.0.0.1:3000/api/cloudflare/oauth/callback";
process.env.CLOUDFLARE_OAUTH_SCOPES = "account:cloudflare_tunnel:edit zone:zone:read zone:dns:edit";
process.env.CLOUDFLARE_OAUTH_ENABLED = "true";

const tokenRequests: URLSearchParams[] = [];
const cloudflareFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "dash.cloudflare.com" && url.pathname === "/oauth2/token") {
    const body = new URLSearchParams(String(init?.body));
    tokenRequests.push(body);
    const refreshed = body.get("grant_type") === "refresh_token";
    return Response.json({
      access_token: refreshed ? "refreshed-access-token" : "initial-access-token",
      refresh_token: refreshed ? "rotated-refresh-token" : "initial-refresh-token",
      expires_in: 3600,
      scope: "tunnel dns",
      token_type: "Bearer",
    });
  }
  const result =
    url.pathname === "/client/v4/accounts"
      ? [{ id: "a".repeat(32), name: "Example account" }]
      : url.pathname === "/client/v4/zones"
        ? [
            {
              id: "b".repeat(32),
              name: "example.com",
              account: { id: "a".repeat(32), name: "Example account" },
            },
          ]
        : [];
  return Response.json({
    success: true,
    result,
    result_info: { page: 1, total_pages: 1 },
  });
});
vi.stubGlobal("fetch", cloudflareFetch);

const [oauth, database, secrets] = await Promise.all([
  import("../../src/server/cloudflare-oauth.ts"),
  import("../../src/server/db.ts"),
  import("../../src/server/crypto.ts"),
]);

const db = database.getDb();
const now = new Date().toISOString();
db.prepare(
  `INSERT INTO users(
    id, username, password_hash, role, disabled, created_at, updated_at
  ) VALUES ('owner-id', 'owner', 'test-only', 'owner', 0, ?, ?)`,
).run(now, now);

afterAll(() => {
  vi.unstubAllGlobals();
  database.closeDb();
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});

describe("Cloudflare OAuth", () => {
  it("binds a single-use callback to the authenticated user and PKCE verifier", async () => {
    const authorization = new URL(await oauth.createCloudflareAuthorization("owner-id"));
    const state = authorization.searchParams.get("state") ?? "";
    const session = db
      .prepare("SELECT verifier_encrypted FROM cloudflare_oauth_sessions")
      .get() as { verifier_encrypted: string };
    const verifier = secrets.decryptSecret(session.verifier_encrypted);
    const expectedChallenge = crypto.createHash("sha256").update(verifier).digest("base64url");

    expect(authorization.origin).toBe("https://dash.cloudflare.com");
    expect(authorization.pathname).toBe("/oauth2/auth");
    expect(authorization.searchParams.get("client_id")).toBe("cloudflare-public-client");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("code_challenge")).toBe(expectedChallenge);
    expect(authorization.searchParams.get("scope")).toBe(
      "account:cloudflare_tunnel:edit zone:zone:read zone:dns:edit",
    );

    await oauth.completeCloudflareAuthorization({
      state,
      code: "authorization-code",
    });

    expect(tokenRequests[0]?.get("code_verifier")).toBe(verifier);
    expect(tokenRequests[0]?.get("client_secret")).toBeNull();
    expect(oauth.cloudflareOAuthStatus("owner-id").pending).toBe(true);
    await expect(
      oauth.completeCloudflareAuthorization({
        state,
        code: "replayed-code",
      }),
    ).rejects.toMatchObject({ code: "cloudflare_oauth_state_invalid" });
  });

  it("discovers authorized accounts and zones and rotates an expiring refresh token", async () => {
    const first = await oauth.cloudflareOAuthOptions("owner-id");
    expect(first).toEqual({
      accounts: [{ id: "a".repeat(32), name: "Example account" }],
      zones: [
        {
          id: "b".repeat(32),
          name: "example.com",
          accountId: "a".repeat(32),
          accountName: "Example account",
        },
      ],
    });

    db.prepare(
      "UPDATE cloudflare_oauth_pending SET access_token_expires_at = ? WHERE singleton = 1",
    ).run(new Date(Date.now() - 1000).toISOString());
    await oauth.cloudflareOAuthOptions("owner-id");

    expect(tokenRequests[1]?.get("grant_type")).toBe("refresh_token");
    expect(tokenRequests[1]?.get("refresh_token")).toBe("initial-refresh-token");
    const pending = db
      .prepare(
        "SELECT access_token_encrypted, refresh_token_encrypted FROM cloudflare_oauth_pending",
      )
      .get() as { access_token_encrypted: string; refresh_token_encrypted: string };
    expect(secrets.decryptSecret(pending.access_token_encrypted)).toBe("refreshed-access-token");
    expect(secrets.decryptSecret(pending.refresh_token_encrypted)).toBe("rotated-refresh-token");
  });
});
