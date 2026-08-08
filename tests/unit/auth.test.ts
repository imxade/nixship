import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "platform-auth-test-"));
process.env.PLATFORM_DATA_DIR = dataDirectory;
process.env.PLATFORM_MASTER_KEY = Buffer.alloc(32, 23).toString("base64");

const [{ authenticateSession, changeOwnPassword, createSession, login }, database, cryptoModule] =
  await Promise.all([
    import("../../src/server/auth.ts"),
    import("../../src/server/db.ts"),
    import("../../src/server/crypto.ts"),
  ]);

const now = "2026-07-24T12:00:00.000Z";
database
  .getDb()
  .prepare(
    `INSERT INTO users(
      id, username, password_hash, role, disabled, created_at, updated_at
    ) VALUES ('owner', 'owner', 'unused', 'owner', 0, ?, ?)`,
  )
  .run(now, now);

beforeEach(async () => {
  database.getDb().prepare("DELETE FROM login_attempts").run();
  database.getDb().prepare("DELETE FROM sessions").run();
  database
    .getDb()
    .prepare("UPDATE users SET password_hash = ? WHERE id = 'owner'")
    .run(await cryptoModule.hashPassword("original owner password"));
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
});

afterAll(() => {
  vi.useRealTimers();
  database.closeDb();
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});

describe("hourly login limits", () => {
  it("limits a source and username pair to six failed password checks per hour", async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      await expect(failedLogin("missing", "192.0.2.10")).rejects.toMatchObject({
        status: 401,
        code: "invalid_credentials",
      });
    }

    await expect(failedLogin("missing", "192.0.2.10")).rejects.toMatchObject({
      status: 429,
      code: "login_rate_limited",
      retryAfterSeconds: 3600,
    });

    vi.advanceTimersByTime(60 * 60_000 + 1);
    await expect(failedLogin("missing", "192.0.2.10")).rejects.toMatchObject({
      status: 401,
      code: "invalid_credentials",
    });
  });

  it("caps failures across usernames from the same source", async () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      await expect(failedLogin(`missing-${attempt}`, "198.51.100.20")).rejects.toMatchObject({
        status: 401,
      });
    }

    await expect(failedLogin("another-user", "198.51.100.20")).rejects.toMatchObject({
      status: 429,
      code: "login_rate_limited",
    });
  });
});

describe("password changes", () => {
  it("requires the current password, retains the current session, and revokes other sessions", async () => {
    const currentSession = createSession("owner", "192.0.2.30", "auth-test-current");
    const otherSession = createSession("owner", "192.0.2.31", "auth-test-other");

    await expect(
      changeOwnPassword({
        userId: "owner",
        currentPassword: "wrong current password",
        newPassword: "replacement owner password",
        currentSessionToken: currentSession.token,
      }),
    ).rejects.toMatchObject({
      status: 401,
      code: "invalid_current_password",
    });

    await changeOwnPassword({
      userId: "owner",
      currentPassword: "original owner password",
      newPassword: "replacement owner password",
      currentSessionToken: currentSession.token,
      ip: "192.0.2.30",
    });

    expect(authenticateSession(currentSession.token)?.username).toBe("owner");
    expect(authenticateSession(otherSession.token)).toBeNull();
    await expect(
      login({
        username: "owner",
        password: "original owner password",
        ip: "192.0.2.30",
      }),
    ).rejects.toMatchObject({ status: 401, code: "invalid_credentials" });
    await expect(
      login({
        username: "owner",
        password: "replacement owner password",
        ip: "192.0.2.30",
      }),
    ).resolves.toMatchObject({ user: { username: "owner" } });
  });
});

async function failedLogin(username: string, ip: string) {
  return login({
    username,
    password: "incorrect password",
    ip,
    userAgent: "auth-test",
  });
}
