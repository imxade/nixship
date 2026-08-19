import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nixship-ai-settings-test-"));
process.env.PLATFORM_DATA_DIR = dataDirectory;
process.env.PLATFORM_MASTER_KEY = Buffer.alloc(32, 47).toString("base64");

const [database, aiSettings] = await Promise.all([
  import("../../src/server/db.ts"),
  import("../../src/server/ai/ai-settings.ts"),
]);

const owner = {
  id: "10000000-0000-4000-8000-000000000001",
  username: "owner",
  role: "owner" as const,
  sessionId: "20000000-0000-4000-8000-000000000001",
};

beforeEach(() => {
  const db = database.getDb();
  db.exec(`
    DELETE FROM audit_events;
    DELETE FROM settings WHERE key LIKE 'ai_%';
    DELETE FROM sessions;
    DELETE FROM users;
  `);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users(id, username, password_hash, role, disabled, created_at, updated_at)
     VALUES (?, ?, 'unused', ?, 0, ?, ?)`,
  ).run(owner.id, owner.username, owner.role, now, now);
  db.prepare(
    `INSERT INTO sessions(id, user_id, token_hash, expires_at, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(owner.sessionId, owner.id, "owner-token", "2099-01-01T00:00:00.000Z", now, now);
});

afterAll(() => {
  database.closeDb();
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});

describe("AI settings defaults", () => {
  it("returns defaults when no settings are stored", () => {
    const settings = aiSettings.getAiSettings();
    expect(settings.maxModelSteps).toBe(6);
    expect(settings.maxSimultaneousReads).toBe(4);
    expect(settings.maxPendingPlanners).toBe(8);
    expect(settings.readToolsLimit).toBe(20);
    expect(settings.capabilitySearchLimit).toBe(16);
    expect(settings.conversationHistoryLimit).toBe(20);
    expect(settings.planExpiryMinutes).toBe(10);
    expect(settings.maxPlanLifetimeMinutes).toBe(30);
    expect(settings.resourceLockTtlMinutes).toBe(10);
    expect(settings.lockRenewalSeconds).toBe(60);
    expect(settings.reauthTtlMinutes).toBe(5);
    expect(settings.secretRefTtlMinutes).toBe(30);
    expect(settings.maxChatInputBytes).toBe(16384);
    expect(settings.maxMessageBytes).toBe(65536);
    expect(settings.providerResponseMaxBytes).toBe(1048576);
  });
});

describe("AI settings persistence", () => {
  it("persists and reads back updated values", () => {
    aiSettings.updateAiSettings({ maxModelSteps: 10, maxPendingPlanners: 4 }, { id: owner.id });
    expect(aiSettings.aiMaxModelSteps()).toBe(10);
    expect(aiSettings.aiMaxPendingPlanners()).toBe(4);
    // Unchanged values retain defaults
    expect(aiSettings.aiMaxSimultaneousReads()).toBe(4);
  });

  it("creates an audit record on update", () => {
    aiSettings.updateAiSettings({ planExpiryMinutes: 15 }, { id: owner.id });
    const audit = database
      .getDb()
      .prepare("SELECT * FROM audit_events WHERE action = 'settings.ai_settings_updated'")
      .all() as Array<{ details_json: string }>;
    expect(audit.length).toBe(1);
    const details = JSON.parse(audit[0]?.details_json ?? "{}");
    expect(details.planExpiryMinutes).toBe(15);
  });
});

describe("AI settings validation", () => {
  it("rejects out-of-range values", () => {
    expect(() => aiSettings.updateAiSettings({ maxModelSteps: 100 }, { id: owner.id })).toThrow();
    expect(() => aiSettings.updateAiSettings({ maxModelSteps: 0 }, { id: owner.id })).toThrow();
    // Value should remain at default
    expect(aiSettings.aiMaxModelSteps()).toBe(6);
  });

  it("rejects negative values", () => {
    expect(() => aiSettings.updateAiSettings({ reauthTtlMinutes: -5 }, { id: owner.id })).toThrow();
  });

  it("falls back to default for corrupted stored values", () => {
    database.setSetting("ai_max_model_steps", "not_a_number");
    expect(aiSettings.aiMaxModelSteps()).toBe(6);
  });

  it("falls back to default for out-of-range stored values", () => {
    database.setSetting("ai_max_model_steps", "999");
    expect(aiSettings.aiMaxModelSteps()).toBe(6);
  });
});

describe("AI settings derived values", () => {
  it("computes millisecond values from minutes", () => {
    aiSettings.updateAiSettings({ planExpiryMinutes: 7 }, { id: owner.id });
    expect(aiSettings.aiPlanExpiryMs()).toBe(7 * 60_000);
  });

  it("computes lock renewal milliseconds from seconds", () => {
    aiSettings.updateAiSettings({ lockRenewalSeconds: 120 }, { id: owner.id });
    expect(aiSettings.aiLockRenewalMs()).toBe(120_000);
  });
});

describe("AI settings bulk operations", () => {
  it("getAiSettings returns all settings after partial update", () => {
    aiSettings.updateAiSettings({ maxModelSteps: 8, reauthTtlMinutes: 10 }, { id: owner.id });
    const all = aiSettings.getAiSettings();
    expect(all.maxModelSteps).toBe(8);
    expect(all.reauthTtlMinutes).toBe(10);
    expect(all.maxSimultaneousReads).toBe(4); // default
    expect(all.providerResponseMaxBytes).toBe(1048576); // default
  });

  it("does not audit when no fields are provided", () => {
    aiSettings.updateAiSettings({}, { id: owner.id });
    const audit = database
      .getDb()
      .prepare("SELECT * FROM audit_events WHERE action = 'settings.ai_settings_updated'")
      .all();
    expect(audit.length).toBe(0);
  });
});
