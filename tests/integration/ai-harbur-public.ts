import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const harburBaseUrl = process.env.AI_HARBUR_TEST_BASE_URL?.trim() || "https://harbur.vercel.app";
const repositoryId = process.env.AI_HARBUR_TEST_REPOSITORY_ID?.trim() || "rb/kitsy";
const integrationToken = process.env.HARBUR_INTEGRATION_READ_TOKEN?.trim() || null;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "nixship-ai-harbur-"));
process.env.PLATFORM_DATA_DIR = path.join(root, "data");
process.env.PLATFORM_MASTER_KEY = Buffer.alloc(32, 89).toString("base64");
process.env.MIN_FREE_DISK_MB = "128";
process.env.MIN_FREE_MEMORY_MB = "64";
process.env.SOURCE_POLL_SECONDS = "86400";
process.env.METRICS_INTERVAL_SECONDS = "2";
process.env.QUICK_TUNNELS_ENABLED = "false";

const [
  database,
  cryptoModule,
  conversations,
  validator,
  planStore,
  executor,
  capabilities,
  reauth,
  secrets,
  runtimeModule,
] = await Promise.all([
  import("../../src/server/db.ts"),
  import("../../src/server/crypto.ts"),
  import("../../src/server/ai/conversation-store.ts"),
  import("../../src/server/ai/plans/validator.ts"),
  import("../../src/server/ai/plans/store.ts"),
  import("../../src/server/ai/plans/executor.ts"),
  import("../../src/server/ai/capabilities/index.ts"),
  import("../../src/server/ai/reauth.ts"),
  import("../../src/server/ai/secrets.ts"),
  import("../../src/server/runtime.ts"),
]);

const password = "harbur integration test password";
const actor = {
  id: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  username: "ai-harbur-owner",
  role: "owner" as const,
};
const appName = `Nix Ship AI Harbur E2E ${crypto.randomBytes(3).toString("hex")}`;
let runtime: InstanceType<typeof runtimeModule.PlatformRuntime> | null = null;
let appId: string | null = null;

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
       VALUES (?, ?, 'direct-harbur-test', '2099-01-01T00:00:00.000Z', ?, ?)`,
    )
    .run(actor.sessionId, actor.id, now, now);
  runtime = new runtimeModule.PlatformRuntime();
  await runtime.boot();
  const conversation = conversations.createConversation(actor);
  const registry = capabilities.aiCapabilities();
  const tokenSecretRef = integrationToken
    ? secrets.createAiSecretReference({
        actor,
        kind: "harbur_token",
        scope: { type: "integration", id: harburBaseUrl },
        value: integrationToken,
      }).secretRef
    : null;
  const connectValidated = await validator.validatePlan(
    plan({
      goal: "Connect the public Harbur integration",
      summary: "Verify Harbur capabilities and repository access without a token.",
      scope: { type: "integration", id: null },
      step: {
        id: "connect-harbur",
        capabilityId: "harbur.connect",
        capabilityVersion: 1,
        title: "Connect Harbur",
        input: { baseUrl: harburBaseUrl, tokenSecretRef, allowPrivateNetwork: false },
        resourceKeys: [`integration:harbur-${cryptoModule.sha256(harburBaseUrl).slice(0, 24)}`],
        risk: "sensitive",
        expectedEffect: "The verified public Harbur integration is stored.",
      },
      expectedResult: "Harbur is connected and its public repositories are readable.",
    }),
    { actor, requestId: "harbur-connect-plan" },
    registry,
  );
  const connectPlan = planStore.persistProposedPlan(conversation.id, actor, connectValidated);
  await reauth.createAiReauthGrant(actor, password);
  const connectRun = await executor.approveAndExecutePlan({
    planId: connectPlan.id,
    planHash: connectPlan.planHash,
    actor,
    requestId: "harbur-connect-approval",
    registry,
  });
  assert.equal(connectRun.status, "succeeded");
  const connectionResult = connectRun.steps[0]?.result as { id: string } | undefined;
  assert.ok(connectionResult);
  const connectionId = connectionResult.id;

  const deployValidated = await validator.validatePlan(
    plan({
      goal: `Deploy ${repositoryId} from Harbur`,
      summary: "Create a distinct application from a verified Harbur snapshot.",
      scope: { type: "global", id: null },
      step: {
        id: "create-harbur-app",
        capabilityId: "apps.createFromSource",
        capabilityVersion: 1,
        title: "Create and deploy Harbur application",
        input: {
          sourceProvider: "harbur",
          name: appName,
          kind: "web",
          harburConnectionId: connectionId,
          harburRepositoryId: repositoryId,
          flakeOutput: "default",
          autoDeploy: true,
          healthPath: "/",
        },
        resourceKeys: [`app-name:${cryptoModule.sha256(appName.toLowerCase()).slice(0, 24)}`],
        risk: "mutation",
        expectedEffect:
          "A distinct application is created from the exact Harbur snapshot and activated.",
      },
      expectedResult: "The Harbur application is healthy and active.",
    }),
    { actor, requestId: "harbur-deploy-plan" },
    registry,
  );
  const deployPlan = planStore.persistProposedPlan(conversation.id, actor, deployValidated);
  const deployRun = await executor.approveAndExecutePlan({
    planId: deployPlan.id,
    planHash: deployPlan.planHash,
    actor,
    requestId: "harbur-deploy-approval",
    registry,
  });
  assert.equal(deployRun.status, "succeeded");
  const deploymentResult = deployRun.steps[0]?.result as {
    appId: string;
    deploymentId: string;
    deploymentState: string;
  };
  appId = deploymentResult.appId;
  assert.equal(deploymentResult.deploymentState, "running");
  const app = database.getDb().prepare("SELECT * FROM applications WHERE id = ?").get(appId) as {
    name: string;
    source_provider: string;
    source_repository_id: string;
    active_deployment_id: string;
    public_port: number;
  };
  assert.equal(app.name, appName);
  assert.equal(app.source_provider, "harbur");
  assert.equal(app.source_repository_id, repositoryId);
  assert.equal(app.active_deployment_id, deploymentResult.deploymentId);
  const response = await fetch(`http://127.0.0.1:${app.public_port}/`);
  assert.ok(response.status >= 200 && response.status < 500);
  process.stdout.write(
    `${JSON.stringify({
      harburBaseUrl,
      repositoryId,
      appName,
      approvedConnectPlan: true,
      approvedDeployPlan: true,
      snapshotDigestVerifiedByRuntime: true,
      deploymentState: deploymentResult.deploymentState,
      activeDeploymentVerified: true,
      localHttpStatus: response.status,
      isolatedDataDirectory: true,
    })}\n`,
  );
} finally {
  if (runtime) {
    if (appId) await runtime.stopApplication(appId).catch(() => undefined);
    await runtime.close().catch(() => undefined);
  }
  database.closeDb();
  fs.rmSync(root, { recursive: true, force: true });
}

function plan(input: {
  goal: string;
  summary: string;
  scope: { type: "global" | "integration"; id: string | null };
  step: {
    id: string;
    capabilityId: string;
    capabilityVersion: number;
    title: string;
    input: Record<string, unknown>;
    resourceKeys: string[];
    risk: "mutation" | "sensitive";
    expectedEffect: string;
  };
  expectedResult: string;
}) {
  return {
    schemaVersion: 1 as const,
    goal: input.goal,
    summary: input.summary,
    scope: input.scope,
    steps: [
      {
        ...input.step,
        dependsOn: [],
        externalWait: false,
      },
    ],
    warnings: ["Workload repository code is trusted and runs as the Nix Ship OS account."],
    expectedResult: input.expectedResult,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
}
