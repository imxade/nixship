import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nixship-ai-test-"));
process.env.PLATFORM_DATA_DIR = dataDirectory;
process.env.PLATFORM_MASTER_KEY = Buffer.alloc(32, 47).toString("base64");

const [database, conversations, capabilities, plans, executor, planner, canonical] =
  await Promise.all([
    import("../../src/server/db.ts"),
    import("../../src/server/ai/conversation-store.ts"),
    import("../../src/server/ai/capabilities/index.ts"),
    import("../../src/server/ai/plans/store.ts"),
    import("../../src/server/ai/plans/executor.ts"),
    import("../../src/server/ai/planner.ts"),
    import("../../src/server/ai/plans/canonicalize.ts"),
  ]);
const { validatePlan } = await import("../../src/server/ai/plans/validator.ts");
const { CapabilityRegistry } = await import("../../src/server/ai/capabilities/registry.ts");
type AiProvider = import("../../src/server/ai/provider.ts").AiProvider;
type ProviderMessage = import("../../src/server/ai/provider.ts").ProviderMessage;
type ProviderTool = import("../../src/server/ai/provider.ts").ProviderTool;

const owner = {
  id: "10000000-0000-4000-8000-000000000001",
  username: "owner",
  role: "owner" as const,
  sessionId: "20000000-0000-4000-8000-000000000001",
};
const viewer = {
  id: "10000000-0000-4000-8000-000000000002",
  username: "viewer",
  role: "viewer" as const,
  sessionId: "20000000-0000-4000-8000-000000000002",
};
const appId = "30000000-0000-4000-8000-000000000001";

beforeEach(() => {
  const db = database.getDb();
  db.exec(`
    DELETE FROM ai_resource_locks;
    DELETE FROM ai_plan_run_steps;
    DELETE FROM ai_plan_runs;
    DELETE FROM ai_plans;
    DELETE FROM ai_messages;
    DELETE FROM ai_conversations;
    DELETE FROM audit_events;
    DELETE FROM deployments;
    DELETE FROM applications;
    DELETE FROM sessions;
    DELETE FROM users;
  `);
  const now = new Date().toISOString();
  const addUser = db.prepare(
    `INSERT INTO users(id, username, password_hash, role, disabled, created_at, updated_at)
     VALUES (?, ?, 'unused', ?, 0, ?, ?)`,
  );
  addUser.run(owner.id, owner.username, owner.role, now, now);
  addUser.run(viewer.id, viewer.username, viewer.role, now, now);
  const addSession = db.prepare(
    `INSERT INTO sessions(id, user_id, token_hash, expires_at, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  addSession.run(owner.sessionId, owner.id, "owner-token", "2099-01-01T00:00:00.000Z", now, now);
  addSession.run(viewer.sessionId, viewer.id, "viewer-token", "2099-01-01T00:00:00.000Z", now, now);
  db.prepare(
    `INSERT INTO applications(
      id, name, slug, kind, repository_url, branch, flake_output, source_provider,
      auto_deploy, desired_state, restart_policy, health_path, health_timeout_seconds,
      startup_timeout_seconds, created_at, updated_at
    ) VALUES (?, 'Old name', 'old-name', 'web', 'https://github.com/example/app.git',
      'main', 'default', 'github', 1, 'running', 'on-failure', '/', 5, 1800, ?, ?)`,
  ).run(appId, now, now);
});

afterAll(() => {
  database.closeDb();
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});

describe("AI plan security boundary", () => {
  it("canonicalizes object keys and binds approval to the exact plan hash", async () => {
    expect(canonical.canonicalHash({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonical.canonicalHash({ a: { c: 3, d: 4 }, b: 2 }),
    );
    const conversation = conversations.createConversation(owner);
    const validated = await validatedRename("New name", owner);
    const stored = plans.persistProposedPlan(conversation.id, owner, validated);

    await expect(
      executor.approveAndExecutePlan({
        planId: stored.id,
        planHash: "0".repeat(64),
        actor: owner,
        requestId: "request-wrong-hash",
        registry: capabilities.aiCapabilities(),
      }),
    ).rejects.toMatchObject({ code: "plan_hash_mismatch" });
    expect(applicationName()).toBe("Old name");

    const run = await executor.approveAndExecutePlan({
      planId: stored.id,
      planHash: stored.planHash,
      actor: owner,
      requestId: "request-approved",
      registry: capabilities.aiCapabilities(),
    });
    expect(run).toMatchObject({ status: "succeeded", steps: [{ status: "succeeded" }] });
    expect(applicationName()).toBe("New name");

    const duplicate = await executor.approveAndExecutePlan({
      planId: stored.id,
      planHash: stored.planHash,
      actor: owner,
      requestId: "request-duplicate",
      registry: capabilities.aiCapabilities(),
    });
    expect(duplicate.id).toBe(run.id);
    expect(database.getDb().prepare("SELECT COUNT(*) AS count FROM ai_plan_runs").get()).toEqual({
      count: 1,
    });
  });

  it("cancels only the exact proposed plan without executing it", async () => {
    const conversation = conversations.createConversation(owner);
    const stored = plans.persistProposedPlan(
      conversation.id,
      owner,
      await validatedRename("Never applied", owner),
    );
    expect(() => plans.cancelPlan(stored.id, "0".repeat(64), owner)).toThrowError();
    const cancelled = plans.cancelPlan(stored.id, stored.planHash, owner);
    expect(cancelled.status).toBe("cancelled");
    expect(applicationName()).toBe("Old name");
    expect(database.getDb().prepare("SELECT COUNT(*) AS count FROM ai_plan_runs").get()).toEqual({
      count: 0,
    });
  });

  it("invalidates a stale plan before mutation", async () => {
    const conversation = conversations.createConversation(owner);
    const stored = plans.persistProposedPlan(
      conversation.id,
      owner,
      await validatedRename("Planned name", owner),
    );
    database
      .getDb()
      .prepare("UPDATE applications SET name = 'Changed elsewhere', updated_at = ? WHERE id = ?")
      .run("2090-01-01T00:00:00.000Z", appId);

    await expect(
      executor.approveAndExecutePlan({
        planId: stored.id,
        planHash: stored.planHash,
        actor: owner,
        requestId: "request-stale",
        registry: capabilities.aiCapabilities(),
      }),
    ).rejects.toMatchObject({ code: "application_changed" });
    expect(applicationName()).toBe("Changed elsewhere");
    expect(plans.getPlan(stored.id, owner).status).toBe("stale");
  });

  it("rechecks the human role from SQLite at approval time", async () => {
    const conversation = conversations.createConversation(owner);
    const stored = plans.persistProposedPlan(
      conversation.id,
      owner,
      await validatedRename("Denied after role change", owner),
    );
    database.getDb().prepare("UPDATE users SET role = 'viewer' WHERE id = ?").run(owner.id);

    await expect(
      executor.approveAndExecutePlan({
        planId: stored.id,
        planHash: stored.planHash,
        actor: owner,
        requestId: "request-role-changed",
        registry: capabilities.aiCapabilities(),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(applicationName()).toBe("Old name");
  });

  it("fails cleanly when another run holds the application lock", async () => {
    const conversation = conversations.createConversation(owner);
    const stored = plans.persistProposedPlan(
      conversation.id,
      owner,
      await validatedRename("Locked name", owner),
    );
    database
      .getDb()
      .prepare(
        "INSERT INTO ai_plan_runs(id, plan_id, status, created_at) VALUES ('blocking-run', ?, 'running', ?)",
      )
      .run(stored.id, new Date().toISOString());
    database
      .getDb()
      .prepare(
        `INSERT INTO ai_resource_locks(resource_key, run_id, acquired_at, expires_at)
         VALUES (?, 'blocking-run', ?, '2099-01-01T00:00:00.000Z')`,
      )
      .run(`app:${appId}`, new Date().toISOString());

    await expect(
      executor.approveAndExecutePlan({
        planId: stored.id,
        planHash: stored.planHash,
        actor: owner,
        requestId: "request-locked",
        registry: capabilities.aiCapabilities(),
      }),
    ).rejects.toMatchObject({ code: "resource_locked" });
    expect(applicationName()).toBe("Old name");
    expect(
      database
        .getDb()
        .prepare("SELECT status, error_code FROM ai_plan_runs WHERE id <> 'blocking-run'")
        .get(),
    ).toEqual({ status: "failed", error_code: "resource_locked" });
  });

  it("renews resource lock leases for long-running plans", async () => {
    const conversation = conversations.createConversation(owner);
    const stored = plans.persistProposedPlan(
      conversation.id,
      owner,
      await validatedRename("Lease test", owner),
    );
    const db = database.getDb();
    db.prepare(
      "INSERT INTO ai_plan_runs(id, plan_id, status, created_at) VALUES ('lease-run', ?, 'running', ?)",
    ).run(stored.id, new Date().toISOString());
    db.prepare(
      `INSERT INTO ai_resource_locks(resource_key, run_id, acquired_at, expires_at)
       VALUES (?, 'lease-run', ?, '2026-07-24T12:01:00.000Z')`,
    ).run(`app:${appId}`, new Date().toISOString());

    const minimumExpiry = Date.now() + 10 * 60_000;
    executor.renewLocks("lease-run");

    const expiresAt = db
      .prepare("SELECT expires_at FROM ai_resource_locks WHERE run_id = 'lease-run'")
      .pluck()
      .get() as string;
    expect(Date.parse(expiresAt)).toBeGreaterThanOrEqual(minimumExpiry);
  });

  it("rejects viewer plans, unregistered capabilities, extra fields, and false resource keys", async () => {
    await expect(validatedRename("Denied", viewer)).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      validatePlan(
        renamePlan("Denied", { capabilityId: "shell.execute" }),
        { actor: owner, requestId: "unknown" },
        capabilities.aiCapabilities(),
      ),
    ).rejects.toMatchObject({ code: "unknown_capability" });
    await expect(
      validatePlan(
        renamePlan("Denied", { extra: "not allowed" }),
        { actor: owner, requestId: "extra" },
        capabilities.aiCapabilities(),
      ),
    ).rejects.toBeTruthy();
    await expect(
      validatePlan(
        renamePlan("Denied", { resourceKeys: ["app:another"] }),
        { actor: owner, requestId: "resource" },
        capabilities.aiCapabilities(),
      ),
    ).rejects.toMatchObject({ code: "invalid_resource_key" });
    await expect(
      validatePlan(
        renamePlan("Denied", { externalWait: true }),
        { actor: owner, requestId: "wait" },
        capabilities.aiCapabilities(),
      ),
    ).rejects.toMatchObject({ code: "external_wait_unsupported" });
  });

  it("enforces registry uniqueness and mutation risk consistency", () => {
    const registry = new CapabilityRegistry();
    const capability = capabilities.aiCapabilities().get("apps.updateName");
    registry.register(capability);
    expect(() => registry.register(capability)).toThrow(/Duplicate capability ID/);
  });
});

describe("AI conversation and provider loop", () => {
  it("encrypts messages at rest and rejects credential-like chat before provider access", async () => {
    const conversation = conversations.createConversation(owner);
    conversations.addMessage({
      conversationId: conversation.id,
      actor: owner,
      role: "user",
      kind: "text",
      content: "sensitive infrastructure note",
    });
    const row = database
      .getDb()
      .prepare("SELECT content_ciphertext FROM ai_messages LIMIT 1")
      .get() as { content_ciphertext: string };
    expect(row.content_ciphertext).not.toContain("sensitive infrastructure note");
    expect(conversations.listMessages(conversation.id, owner)[0]?.content).toBe(
      "sensitive infrastructure note",
    );

    const provider = new QueueProvider([{ content: "should not run", toolCalls: [] }]);
    await expect(
      planner.runPlanner({
        conversationId: conversation.id,
        actor: owner,
        text: "api_key=sk_this_must_never_reach_a_model",
        provider,
      }),
    ).rejects.toMatchObject({ code: "credential_in_chat" });
    expect(provider.requests).toHaveLength(0);
  });

  it("executes only read tools during planning and returns an answer", async () => {
    const conversation = conversations.createConversation(owner);
    const provider = new QueueProvider([
      {
        content: null,
        toolCalls: [{ id: "read-1", name: "cap__apps__list", arguments: {} }],
      },
      { content: "There is one application named Old name.", toolCalls: [] },
    ]);
    const outcome = await planner.runPlanner({
      conversationId: conversation.id,
      actor: owner,
      text: "Which apps are configured?",
      provider,
    });
    expect(outcome).toEqual({
      type: "answer",
      content: "There is one application named Old name.",
    });
    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "read-1",
    });
    expect(provider.requests[0]?.tools.map((tool) => tool.name)).not.toContain("apps.updateName");
  });

  it("persists but does not execute a model-proposed rename plan", async () => {
    const conversation = conversations.createConversation(owner);
    const provider = new QueueProvider([
      {
        content: null,
        toolCalls: [
          { id: "plan-1", name: "propose_plan", arguments: { plan: renamePlan("Proposed only") } },
        ],
      },
    ]);
    const outcome = await planner.runPlanner({
      conversationId: conversation.id,
      actor: owner,
      text: "Rename the app",
      provider,
    });
    expect(outcome.type).toBe("plan");
    expect(applicationName()).toBe("Old name");
    expect(database.getDb().prepare("SELECT status FROM ai_plans").get()).toEqual({
      status: "proposed",
    });
    expect(database.getDb().prepare("SELECT COUNT(*) AS count FROM ai_plan_runs").get()).toEqual({
      count: 0,
    });
  });
});

async function validatedRename(name: string, actor: typeof owner | typeof viewer) {
  return validatePlan(
    renamePlan(name),
    { actor, requestId: "validate" },
    capabilities.aiCapabilities(),
  );
}

function renamePlan(name: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    goal: `Rename app to ${name}`,
    summary: "Change only the display name.",
    scope: { type: "app", id: appId },
    steps: [
      {
        id: "rename",
        capabilityId: "apps.updateName",
        capabilityVersion: 1,
        title: "Rename application",
        input: { appId, name },
        resourceKeys: [`app:${appId}`],
        dependsOn: [],
        risk: "mutation",
        expectedEffect: `The display name becomes ${name}.`,
        externalWait: false,
        ...overrides,
      },
    ],
    warnings: ["The stable slug is unchanged."],
    expectedResult: `The application is named ${name}.`,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
}

function applicationName(): string {
  return (
    database.getDb().prepare("SELECT name FROM applications WHERE id = ?").get(appId) as {
      name: string;
    }
  ).name;
}

class QueueProvider implements AiProvider {
  readonly id = "fake-ci";
  readonly modelId = "deterministic";
  readonly plannerProbeBypass = true;
  readonly requests: Array<{ messages: ProviderMessage[]; tools: ProviderTool[] }> = [];

  constructor(
    private readonly responses: Array<{
      content: string | null;
      toolCalls: Array<{ id: string; name: string; arguments: unknown }>;
    }>,
  ) {}

  async complete(messages: ProviderMessage[], tools: ProviderTool[]) {
    this.requests.push({ messages: structuredClone(messages), tools: structuredClone(tools) });
    const response = this.responses.shift();
    if (!response) throw new Error("No fake response configured");
    return response;
  }
}
