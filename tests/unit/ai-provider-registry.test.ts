import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nixship-ai-provider-test-"));
process.env.PLATFORM_DATA_DIR = dataDirectory;
process.env.PLATFORM_MASTER_KEY = Buffer.alloc(32, 83).toString("base64");

const database = await import("../../src/server/db.ts");
const secrets = await import("../../src/server/ai/secrets.ts");
const providers = await import("../../src/server/ai/provider-registry.ts");
const actor = {
  id: "81000000-0000-4000-8000-000000000001",
  username: "owner",
  role: "owner" as const,
  sessionId: "82000000-0000-4000-8000-000000000001",
};

beforeEach(() => {
  const db = database.getDb();
  db.exec(`
    DELETE FROM ai_secret_refs;
    DELETE FROM ai_model_profiles;
    DELETE FROM ai_provider_configs;
    DELETE FROM settings WHERE key LIKE 'ai_%';
    DELETE FROM audit_events;
    DELETE FROM sessions;
    DELETE FROM users;
  `);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users(id, username, password_hash, role, disabled, created_at, updated_at)
     VALUES (?, 'owner', 'unused', 'owner', 0, ?, ?)`,
  ).run(actor.id, now, now);
  db.prepare(
    `INSERT INTO sessions(id, user_id, token_hash, expires_at, created_at, last_seen_at)
     VALUES (?, ?, 'token', '2099-01-01T00:00:00.000Z', ?, ?)`,
  ).run(actor.sessionId, actor.id, now, now);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "probe",
            object: "chat.completion",
            created: 0,
            model: "test-model",
            choices: [
              { index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
  );
});

afterEach(() => vi.unstubAllGlobals());

afterAll(() => {
  database.closeDb();
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});

describe("persisted AI provider registry", () => {
  it("validates a provider, encrypts its key, and returns only safe metadata", async () => {
    const baseUrl = "http://127.0.0.1:11434/v1";
    const marker = "provider-key-marker-never-return";
    const reference = secrets.createAiSecretReference({
      actor,
      kind: "provider_api_key",
      scope: { type: "ai", id: baseUrl },
      value: marker,
    });
    const configured = await providers.configureAiProvider(actor, {
      name: "Local test",
      baseUrl,
      secretRef: reference.secretRef,
      allowPrivateNetwork: true,
      timeoutSeconds: 30,
      maxOutputTokens: 512,
      models: [{ modelId: "test-model", displayName: "Test Model" }],
    });

    expect(configured).toMatchObject({
      name: "Local test",
      hasApiKey: true,
      models: [{ modelId: "test-model", answerCapable: true }],
    });
    expect(JSON.stringify(configured)).not.toContain(marker);
    const stored = database
      .getDb()
      .prepare("SELECT api_key_ciphertext FROM ai_provider_configs WHERE id = ?")
      .get(configured.id) as { api_key_ciphertext: string };
    expect(stored.api_key_ciphertext).not.toContain(marker);
    expect(configured.models[0]?.conversationDefault).toBe(true);
    expect(() =>
      secrets.inspectAiSecretReference({
        actor,
        secretRef: reference.secretRef,
        kind: "provider_api_key",
        scope: { type: "ai", id: baseUrl },
      }),
    ).toThrowError(/missing or expired/);
  });

  it("blocks removing a selected provider and rejects an unprobed planner default", async () => {
    const configured = await providers.configureAiProvider(actor, {
      name: "No-key local",
      baseUrl: "http://127.0.0.1:11434/v1",
      secretRef: null,
      allowPrivateNetwork: true,
      timeoutSeconds: 30,
      maxOutputTokens: 512,
      models: [{ modelId: "test-model", displayName: "Test Model" }],
    });
    const profile = configured.models[0];
    expect(profile).toBeDefined();
    expect(() => providers.removeAiProvider(actor, configured.id)).toThrowError(/replacement/);
    expect(() =>
      providers.setAiModelDefault(actor, profile?.id ?? "", "action_planner"),
    ).toThrowError(/action-planner probe/);
  });

  it("supports multiple provider types through LiteLLM and presets", async () => {
    const catalog = await import("../../src/server/ai/provider-catalog.ts");
    expect(catalog.AI_PROVIDER_PRESETS.length).toBeGreaterThan(5);
    const anthropicPreset = catalog.findProviderPreset("anthropic");
    expect(anthropicPreset).toBeDefined();
    expect(anthropicPreset?.defaultBaseUrl).toContain("anthropic.com");

    const litellmPreset = catalog.findProviderPreset("litellm");
    expect(litellmPreset).toBeDefined();
    expect(litellmPreset?.allowPrivateNetworkDefault).toBe(true);

    const configured = await providers.configureAiProvider(actor, {
      type: "anthropic",
      name: "Anthropic Claude",
      baseUrl: "https://127.0.0.1:8443/v1",
      secretRef: null,
      allowPrivateNetwork: true,
      timeoutSeconds: 60,
      maxOutputTokens: 2048,
      models: [
        { modelId: "claude-3-5-sonnet-latest", displayName: "Claude 3.5 Sonnet" },
        { modelId: "claude-3-5-haiku-latest", displayName: "Claude 3.5 Haiku" },
      ],
    });

    expect(configured.type).toBe("anthropic");
    expect(configured.models).toHaveLength(2);

    const all = providers.listAiProviders();
    const found = all.find((p) => p.id === configured.id);
    expect(found?.type).toBe("anthropic");
    expect(found?.models.some((m) => m.modelId === "claude-3-5-sonnet-latest")).toBe(true);
    expect(found?.models.some((m) => m.modelId === "claude-3-5-haiku-latest")).toBe(true);
  });
});
