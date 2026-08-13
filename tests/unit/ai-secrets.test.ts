import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nixship-ai-secret-test-"));
process.env.PLATFORM_DATA_DIR = dataDirectory;
process.env.PLATFORM_MASTER_KEY = Buffer.alloc(32, 71).toString("base64");

const database = await import("../../src/server/db.ts");
const secrets = await import("../../src/server/ai/secrets.ts");
const reauth = await import("../../src/server/ai/reauth.ts");
const crypto = await import("../../src/server/crypto.ts");
const passwordHash = await crypto.hashPassword("correct horse battery staple");
const actor = {
  id: "60000000-0000-4000-8000-000000000001",
  username: "owner",
  role: "owner" as const,
  sessionId: "70000000-0000-4000-8000-000000000001",
};

beforeEach(() => {
  const db = database.getDb();
  db.exec(
    "DELETE FROM ai_reauth_grants; DELETE FROM ai_secret_refs; DELETE FROM login_attempts; DELETE FROM sessions; DELETE FROM users;",
  );
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users(id, username, password_hash, role, disabled, created_at, updated_at)
     VALUES (?, 'owner', ?, 'owner', 0, ?, ?)`,
  ).run(actor.id, passwordHash, now, now);
  db.prepare(
    `INSERT INTO sessions(id, user_id, token_hash, expires_at, created_at, last_seen_at)
     VALUES (?, ?, 'token-hash', '2099-01-01T00:00:00.000Z', ?, ?)`,
  ).run(actor.sessionId, actor.id, now, now);
});

afterAll(() => {
  database.closeDb();
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});

describe("opaque AI secure input", () => {
  it("encrypts plaintext, binds scope and actor, and consumes exactly once", () => {
    const marker = "secret-marker-that-must-not-leak";
    const scope = { type: "app" as const, id: "app-1" };
    const reference = secrets.createAiSecretReference({
      actor,
      kind: "dotenv",
      scope,
      value: marker,
    });
    expect(reference.secretRef).toMatch(/^aisec_/);
    const stored = database
      .getDb()
      .prepare("SELECT ciphertext FROM ai_secret_refs WHERE id = ?")
      .get(reference.secretRef) as { ciphertext: string };
    expect(stored.ciphertext).not.toContain(marker);
    expect(
      secrets.inspectAiSecretReference({
        actor,
        secretRef: reference.secretRef,
        kind: "dotenv",
        scope,
      }),
    ).toMatchObject({ stored: true, kind: "dotenv" });
    expect(
      secrets.consumeAiSecretReference({
        actor,
        secretRef: reference.secretRef,
        kind: "dotenv",
        scope,
      }),
    ).toBe(marker);
    expect(
      database
        .getDb()
        .prepare("SELECT 1 FROM ai_secret_refs WHERE id = ?")
        .get(reference.secretRef),
    ).toBeUndefined();
    expect(() =>
      secrets.consumeAiSecretReference({
        actor,
        secretRef: reference.secretRef,
        kind: "dotenv",
        scope,
      }),
    ).toThrowError(/missing or expired/);
  });

  it("rejects a wrong scope and an expired reference without revealing plaintext", () => {
    const reference = secrets.createAiSecretReference({
      actor,
      kind: "cloudflare_api_token",
      scope: { type: "global", id: null },
      value: "known-secret-marker",
      ttlMs: -1,
    });
    expect(() =>
      secrets.inspectAiSecretReference({
        actor,
        secretRef: reference.secretRef,
        kind: "cloudflare_api_token",
        scope: { type: "integration", id: null },
      }),
    ).toThrowError(/missing or expired/);
  });
});

describe("AI plan reauthentication", () => {
  it("binds a short-lived grant to the authenticated user and session", async () => {
    await expect(reauth.createAiReauthGrant(actor, "wrong password")).rejects.toMatchObject({
      code: "reauth_failed",
    });
    expect(() => reauth.assertFreshAiReauth(actor)).toThrowError(/Re-enter/);
    const grant = await reauth.createAiReauthGrant(actor, "correct horse battery staple");
    expect(Date.parse(grant.expiresAt)).toBeGreaterThan(Date.now());
    expect(() => reauth.assertFreshAiReauth(actor)).not.toThrow();
  });

  it("limits repeated current-password failures", async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      await expect(
        reauth.createAiReauthGrant(actor, "wrong password", "192.0.2.55"),
      ).rejects.toMatchObject({ code: "reauth_failed" });
    }
    await expect(
      reauth.createAiReauthGrant(actor, "wrong password", "192.0.2.55"),
    ).rejects.toMatchObject({ code: "password_check_rate_limited", status: 429 });
  });
});
