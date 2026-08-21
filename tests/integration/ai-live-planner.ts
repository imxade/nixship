/**
 * Live AI planner integration tests using the real local model (qwen2.5:7b).
 *
 * Unlike deterministic tests that script tool calls, this suite passes
 * natural-language prompts to runPlanner() and verifies the model produces
 * valid, executable plans.
 *
 * Usage:
 *   nix develop .#ai --command bash -c "
 *     export AI_LOCAL_TEST_BASE_URL=http://127.0.0.1:11434/v1
 *     export AI_LOCAL_TEST_MODEL=qwen2.5:7b
 *     export HARBUR_INTEGRATION_READ_TOKEN=0cry1R9ZW1gEduW2OU/2zh8ezZpG8Oj2U8HjwtstW9OCT9FLRfxr99yzRIHHeIpU
 *     npx tsx tests/integration/ai-live-planner.ts
 *   "
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const baseUrl = process.env.AI_LOCAL_TEST_BASE_URL?.trim() || "http://127.0.0.1:11434/v1";
const modelId = process.env.AI_LOCAL_TEST_MODEL?.trim() || "qwen2.5:7b";
const harburToken = process.env.HARBUR_INTEGRATION_READ_TOKEN?.trim() || null;
const harburBaseUrl = process.env.HARBUR_TEST_BASE_URL?.trim() || "https://harbur.vercel.app";
const harburRepository = process.env.HARBUR_TEST_REPOSITORY_ID?.trim() || "rb/kitsy";
const harburSourceUrl = `${harburBaseUrl}/repo/${harburRepository}`;
const githubRepository =
  process.env.AI_PUBLIC_TEST_REPOSITORY_URL?.trim() || "https://github.com/imxade/kitsy";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "nixship-ai-live-"));
process.env.PLATFORM_DATA_DIR = path.join(root, "data");
process.env.PLATFORM_MASTER_KEY = Buffer.alloc(32, 91).toString("base64");
process.env.MIN_FREE_DISK_MB = "128";
process.env.MIN_FREE_MEMORY_MB = "64";
process.env.SOURCE_POLL_SECONDS = "86400";
process.env.METRICS_INTERVAL_SECONDS = "2";
process.env.QUICK_TUNNELS_ENABLED = "false";

const [
  database,
  cryptoModule,
  conversations,
  planner,
  executor,
  capabilityModule,
  runtimeModule,
  reauth,
  harburModule,
] = await Promise.all([
  import("../../src/server/db.ts"),
  import("../../src/server/crypto.ts"),
  import("../../src/server/ai/conversation-store.ts"),
  import("../../src/server/ai/planner.ts"),
  import("../../src/server/ai/plans/executor.ts"),
  import("../../src/server/ai/capabilities/index.ts"),
  import("../../src/server/runtime.ts"),
  import("../../src/server/ai/reauth.ts"),
  import("../../src/server/harbur.ts"),
]);
const { OpenAiCompatibleProvider } = await import("../../src/server/ai/provider.ts");

const password = "live planner test password";
const actor = {
  id: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  username: "ai-live-owner",
  role: "owner" as const,
};

const provider = new OpenAiCompatibleProvider({
  baseUrl,
  modelId,
  allowPrivateNetwork: true,
  timeoutMs: 180_000,
  maxOutputTokens: 2048,
  disableReasoning: true,
  plannerProbeBypass: true,
});

interface ScenarioResult {
  name: string;
  passed: boolean;
  detail: string;
  durationMs: number;
}
const results: ScenarioResult[] = [];

let runtime: InstanceType<typeof runtimeModule.PlatformRuntime> | null = null;
const createdAppIds: string[] = [];

try {
  const now = new Date().toISOString();
  const passwordHash = await cryptoModule.hashPassword(password);
  database
    .getDb()
    .prepare(
      `INSERT INTO users(id, username, password_hash, role, disabled, created_at, updated_at)
       VALUES (?, ?, ?, 'owner', 0, ?, ?)`,
    )
    .run(actor.id, actor.username, passwordHash, now, now);
  database
    .getDb()
    .prepare(
      `INSERT INTO sessions(id, user_id, token_hash, expires_at, created_at, last_seen_at)
       VALUES (?, ?, 'direct-live-test', '2099-01-01T00:00:00.000Z', ?, ?)`,
    )
    .run(actor.sessionId, actor.id, now, now);
  runtime = new runtimeModule.PlatformRuntime();
  await runtime.boot();
  database.setSetting("ai_max_model_steps", "10");
  await reauth.createAiReauthGrant(actor, password);

  // Pre-connect Harbur integration if token is available
  if (harburToken) {
    process.stderr.write(`Connecting Harbur integration at ${harburBaseUrl}...\n`);
    await harburModule.connectHarbur(
      { baseUrl: harburBaseUrl, token: harburToken, allowPrivateNetwork: false },
      { id: actor.id },
    );
    process.stderr.write(`Harbur connected successfully.\n`);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Scenario 1: Deploy from Harbur
  // ──────────────────────────────────────────────────────────────────────
  const harburAppName = `Kitsy Harbur Live ${crypto.randomBytes(3).toString("hex")}`;
  if (harburToken) {
    await scenario("deploy from Harbur (URL prompt)", async () => {
      const conversation = conversations.createConversation(actor);
      const outcome = await planner.runPlanner({
        conversationId: conversation.id,
        actor,
        text: `Deploy ${harburSourceUrl} as "${harburAppName}"`,
        provider,
        requestId: "live-harbur-deploy",
      });
      assert.equal(outcome.type, "plan", `Expected plan, got ${outcome.type}`);
      if (outcome.type !== "plan") throw new Error("unreachable");
      const step = outcome.plan.plan.steps.find(
        (s: { capabilityId: string }) => s.capabilityId === "apps.createFromSource",
      );
      assert.ok(
        step,
        `Plan must contain apps.createFromSource, got: ${outcome.plan.plan.steps.map((s: { capabilityId: string }) => s.capabilityId).join(", ")}`,
      );
      assert.equal(
        (step.input as { sourceProvider?: string }).sourceProvider,
        "harbur",
        "Expected sourceProvider to be harbur",
      );

      const run = await executor.approveAndExecutePlan({
        planId: outcome.plan.id,
        planHash: outcome.plan.planHash,
        actor,
        requestId: "live-harbur-deploy-approval",
        registry: capabilityModule.aiCapabilities(),
      });
      assert.equal(run.status, "succeeded", `Run failed: ${run.errorSummary ?? "unknown"}`);
      const result = run.steps[0]?.result as { appId: string } | undefined;
      assert.ok(result?.appId);
      createdAppIds.push(result.appId);

      const app = database
        .getDb()
        .prepare("SELECT name, source_provider FROM applications WHERE id = ?")
        .get(result.appId) as { name: string; source_provider: string };
      assert.equal(app.source_provider, "harbur");
      assert.ok(app.name.toLowerCase().includes("kitsy") || app.name === harburAppName);
    });
  } else {
    results.push({
      name: "deploy from Harbur (URL prompt)",
      passed: true,
      detail: "skipped (no HARBUR_INTEGRATION_READ_TOKEN)",
      durationMs: 0,
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // Scenario 2: Deploy from public GitHub
  // ──────────────────────────────────────────────────────────────────────
  const githubAppName = `Kitsy GitHub Live ${crypto.randomBytes(3).toString("hex")}`;
  await scenario("deploy public GitHub repo", async () => {
    const conversation = conversations.createConversation(actor);
    const outcome = await planner.runPlanner({
      conversationId: conversation.id,
      actor,
      text: `Deploy ${githubRepository} as "${githubAppName}"`,
      provider,
      requestId: "live-github-deploy",
    });
    assert.equal(outcome.type, "plan", `Expected plan, got ${outcome.type}`);
    if (outcome.type !== "plan") throw new Error("unreachable");
    const step = outcome.plan.plan.steps.find(
      (s: { capabilityId: string }) => s.capabilityId === "apps.createFromSource",
    );
    assert.ok(
      step,
      `Plan must contain apps.createFromSource, got: ${outcome.plan.plan.steps.map((s: { capabilityId: string }) => s.capabilityId).join(", ")}`,
    );
    assert.equal(
      (step.input as { sourceProvider?: string }).sourceProvider,
      "github",
      "Expected sourceProvider to be github",
    );

    const run = await executor.approveAndExecutePlan({
      planId: outcome.plan.id,
      planHash: outcome.plan.planHash,
      actor,
      requestId: "live-github-deploy-approval",
      registry: capabilityModule.aiCapabilities(),
    });
    assert.equal(run.status, "succeeded", `Run failed: ${run.errorSummary ?? "unknown"}`);
    const result = run.steps[0]?.result as { appId: string } | undefined;
    assert.ok(result?.appId);
    createdAppIds.push(result.appId);
    const app = database
      .getDb()
      .prepare("SELECT name, source_provider FROM applications WHERE id = ?")
      .get(result.appId) as { name: string; source_provider: string };
    assert.equal(app.source_provider, "github");
    assert.ok(app.name.toLowerCase().includes("kitsy") || app.name === githubAppName);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Scenario 3: Rename application
  // ──────────────────────────────────────────────────────────────────────
  const renamedName = `Renamed App ${crypto.randomBytes(3).toString("hex")}`;
  await scenario("rename application", async () => {
    const targetAppId = createdAppIds.at(-1);
    assert.ok(targetAppId, "requires a created app");
    const currentApp = database
      .getDb()
      .prepare("SELECT name FROM applications WHERE id = ?")
      .get(targetAppId) as { name: string };
    const conversation = conversations.createConversation(actor);
    const outcome = await planner.runPlanner({
      conversationId: conversation.id,
      actor,
      text: `Rename the application "${currentApp.name}" to "${renamedName}"`,
      provider,
      requestId: "live-rename",
    });
    assert.equal(outcome.type, "plan", `Expected plan, got ${outcome.type}`);
    if (outcome.type !== "plan") throw new Error("unreachable");
    const step = outcome.plan.plan.steps.find(
      (s: { capabilityId: string }) => s.capabilityId === "apps.updateName",
    );
    assert.ok(
      step,
      `Plan must contain apps.updateName, got: ${outcome.plan.plan.steps.map((s: { capabilityId: string }) => s.capabilityId).join(", ")}`,
    );
    const run = await executor.approveAndExecutePlan({
      planId: outcome.plan.id,
      planHash: outcome.plan.planHash,
      actor,
      requestId: "live-rename-approval",
      registry: capabilityModule.aiCapabilities(),
    });
    assert.equal(run.status, "succeeded", `Run failed: ${run.errorSummary ?? "unknown"}`);
    const updated = database
      .getDb()
      .prepare("SELECT name FROM applications WHERE id = ?")
      .get(targetAppId) as { name: string };
    assert.equal(updated.name, renamedName);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Scenario 4: Stop application
  // ──────────────────────────────────────────────────────────────────────
  await scenario("stop application", async () => {
    const targetAppId = createdAppIds.at(-1);
    assert.ok(targetAppId, "requires a created app");
    const conversation = conversations.createConversation(actor);
    const outcome = await planner.runPlanner({
      conversationId: conversation.id,
      actor,
      text: `Stop the application "${renamedName}"`,
      provider,
      requestId: "live-stop",
    });
    assert.equal(outcome.type, "plan", `Expected plan, got ${outcome.type}`);
    if (outcome.type !== "plan") throw new Error("unreachable");
    const step = outcome.plan.plan.steps.find(
      (s: { capabilityId: string }) =>
        s.capabilityId === "apps.stop" || s.capabilityId === "apps.updateState",
    );
    assert.ok(
      step,
      `Plan must contain apps.stop or apps.updateState, got: ${outcome.plan.plan.steps.map((s: { capabilityId: string }) => s.capabilityId).join(", ")}`,
    );
    const run = await executor.approveAndExecutePlan({
      planId: outcome.plan.id,
      planHash: outcome.plan.planHash,
      actor,
      requestId: "live-stop-approval",
      registry: capabilityModule.aiCapabilities(),
    });
    assert.equal(run.status, "succeeded", `Run failed: ${run.errorSummary ?? "unknown"}`);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Scenario 5: Start application
  // ──────────────────────────────────────────────────────────────────────
  await scenario("start application", async () => {
    const targetAppId = createdAppIds.at(-1);
    assert.ok(targetAppId, "requires a created app");
    const conversation = conversations.createConversation(actor);
    const outcome = await planner.runPlanner({
      conversationId: conversation.id,
      actor,
      text: `Start the application "${renamedName}"`,
      provider,
      requestId: "live-start",
    });
    assert.equal(outcome.type, "plan", `Expected plan, got ${outcome.type}`);
    if (outcome.type !== "plan") throw new Error("unreachable");
    const step = outcome.plan.plan.steps.find(
      (s: { capabilityId: string }) =>
        s.capabilityId === "apps.start" || s.capabilityId === "apps.updateState",
    );
    assert.ok(
      step,
      `Plan must contain apps.start or apps.updateState, got: ${outcome.plan.plan.steps.map((s: { capabilityId: string }) => s.capabilityId).join(", ")}`,
    );
    const run = await executor.approveAndExecutePlan({
      planId: outcome.plan.id,
      planHash: outcome.plan.planHash,
      actor,
      requestId: "live-start-approval",
      registry: capabilityModule.aiCapabilities(),
    });
    assert.equal(run.status, "succeeded", `Run failed: ${run.errorSummary ?? "unknown"}`);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Scenario 6: List applications (read query)
  // ──────────────────────────────────────────────────────────────────────
  await scenario("list applications (answer)", async () => {
    const conversation = conversations.createConversation(actor);
    const outcome = await planner.runPlanner({
      conversationId: conversation.id,
      actor,
      text: "List all deployed applications and their status",
      provider,
      requestId: "live-list",
    });
    assert.ok(
      outcome.type === "answer" || outcome.type === "plan",
      `Expected answer or plan, got ${outcome.type}`,
    );
    if (outcome.type === "answer") {
      assert.ok(outcome.content.length > 0, "Answer should not be empty");
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // Print results
  // ──────────────────────────────────────────────────────────────────────
  const allPassed = results.every((r) => r.passed);
  process.stdout.write(
    `${JSON.stringify({ modelId, baseUrl, allPassed, scenarioCount: results.length, results }, null, 2)}\n`,
  );
  if (!allPassed) process.exitCode = 1;
} finally {
  if (runtime) {
    for (const appId of createdAppIds) {
      await runtime.stopApplication(appId).catch(() => undefined);
    }
    await runtime.close().catch(() => undefined);
  }
  database.closeDb();
  fs.rmSync(root, { recursive: true, force: true });
}

async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  process.stderr.write(`▶ ${name}… `);
  try {
    await fn();
    const ms = Date.now() - start;
    results.push({ name, passed: true, detail: `${ms}ms`, durationMs: ms });
    process.stderr.write(`✓ (${ms}ms)\n`);
  } catch (error) {
    const ms = Date.now() - start;
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, passed: false, detail, durationMs: ms });
    process.stderr.write(`✗ ${detail}\n`);
  }
}
