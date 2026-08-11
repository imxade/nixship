import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repositoryUrl =
  process.env.AI_PUBLIC_TEST_REPOSITORY_URL?.trim() || "https://github.com/imxade/kitsy";
if (!/^https:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?$/i.test(repositoryUrl)) {
  throw new Error("AI_PUBLIC_TEST_REPOSITORY_URL must be an exact public GitHub repository URL");
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "nixship-ai-public-github-"));
process.env.PLATFORM_DATA_DIR = path.join(root, "data");
process.env.PLATFORM_MASTER_KEY = Buffer.alloc(32, 73).toString("base64");
process.env.MIN_FREE_DISK_MB = "128";
process.env.MIN_FREE_MEMORY_MB = "64";
process.env.SOURCE_POLL_SECONDS = "86400";
process.env.METRICS_INTERVAL_SECONDS = "2";
process.env.QUICK_TUNNELS_ENABLED = "false";

const [database, conversations, planner, capabilityModule, executor, runtimeModule, cryptoModule] =
  await Promise.all([
    import("../../src/server/db.ts"),
    import("../../src/server/ai/conversation-store.ts"),
    import("../../src/server/ai/planner.ts"),
    import("../../src/server/ai/capabilities/index.ts"),
    import("../../src/server/ai/plans/executor.ts"),
    import("../../src/server/runtime.ts"),
    import("../../src/server/crypto.ts"),
  ]);
type AiProvider = import("../../src/server/ai/provider.ts").AiProvider;
type ProviderMessage = import("../../src/server/ai/provider.ts").ProviderMessage;
type ProviderTool = import("../../src/server/ai/provider.ts").ProviderTool;

const userId = crypto.randomUUID();
const sessionId = crypto.randomUUID();
const actor = { id: userId, sessionId, username: "ai-e2e-owner", role: "owner" as const };
const appName = `Kitsy AI GitHub E2E ${crypto.randomBytes(3).toString("hex")}`;
let runtime: InstanceType<typeof runtimeModule.PlatformRuntime> | null = null;
let appId: string | null = null;

async function runTest(): Promise<void> {
  try {
    const now = new Date().toISOString();
    database
      .getDb()
      .prepare(
        `INSERT INTO users(id, username, password_hash, role, disabled, created_at, updated_at)
       VALUES (?, ?, 'unused-in-direct-integration-test', 'owner', 0, ?, ?)`,
      )
      .run(userId, actor.username, now, now);
    database
      .getDb()
      .prepare(
        `INSERT INTO sessions(id, user_id, token_hash, expires_at, created_at, last_seen_at)
       VALUES (?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`,
      )
      .run(sessionId, userId, "direct-test-session", now, now);

    runtime = new runtimeModule.PlatformRuntime();
    await runtime.boot();
    const conversation = conversations.createConversation(actor);
    const provider = new DeploymentPlanningProvider(repositoryUrl, appName, cryptoModule.sha256);
    const outcome = await planner.runPlanner({
      conversationId: conversation.id,
      actor,
      text: `Deploy ${repositoryUrl} as ${appName}`,
      provider,
      requestId: "ai-public-github-planning",
    });
    assert.equal(outcome.type, "plan");
    if (outcome.type !== "plan") throw new Error("The deterministic model did not propose a plan");
    assert.equal(provider.readSourceBeforePlan, true);
    assert.equal(provider.searchedCapabilitiesBeforePlan, true);
    assert.equal(
      (
        database.getDb().prepare("SELECT COUNT(*) AS count FROM applications").get() as {
          count: number;
        }
      ).count,
      0,
    );

    const run = await executor.approveAndExecutePlan({
      planId: outcome.plan.id,
      planHash: outcome.plan.planHash,
      actor,
      requestId: "ai-public-github-approval",
      registry: capabilityModule.aiCapabilities(),
    });
    assert.equal(run.status, "succeeded");
    const result = run.steps[0]?.result as
      | { appId: string; deploymentId: string; name: string }
      | undefined;
    assert.ok(result);
    assert.equal(result.name, appName);
    appId = result.appId;
    const deployment = await waitForDeployment(database.getDb(), result.deploymentId, 15 * 60_000);
    const app = database.getDb().prepare("SELECT * FROM applications WHERE id = ?").get(appId) as {
      name: string;
      repository_url: string;
      public_port: number;
      active_deployment_id: string | null;
    };
    assert.equal(app.name, appName);
    assert.match(app.repository_url, /^https:\/\/github\.com\/imxade\/kitsy(?:\.git)?$/i);
    assert.equal(app.active_deployment_id, deployment.id);
    const response = await fetch(`http://127.0.0.1:${app.public_port}/`);
    assert.ok(
      response.status >= 200 && response.status < 500,
      `deployed app returned HTTP ${response.status}`,
    );

    process.stdout.write(
      `${JSON.stringify({
        repositoryUrl,
        appName,
        sourceInspectedBeforePlan: true,
        mutationBeforeApproval: false,
        exactPlanApproved: true,
        deterministicExecutor: true,
        deploymentId: deployment.id,
        deploymentState: deployment.state,
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
}

class DeploymentPlanningProvider implements AiProvider {
  readonly id = "deterministic-ai-e2e";
  readonly modelId = "fixture-tool-model";
  readonly plannerProbeBypass = true;
  readSourceBeforePlan = false;
  searchedCapabilitiesBeforePlan = false;
  private turn = 0;

  constructor(
    private readonly repository: string,
    private readonly name: string,
    private readonly hash: (value: string) => string,
  ) {}

  async complete(messages: ProviderMessage[], _tools: ProviderTool[]) {
    this.turn += 1;
    if (this.turn === 1) {
      return {
        content: null,
        toolCalls: [
          {
            id: "inspect-source",
            name: "cap__sources__inspectGitHubPublicRepository",
            arguments: { repositoryUrl: this.repository, branch: "master" },
          },
        ],
      };
    }
    if (this.turn === 2) {
      const sourceResult = messages.at(-1);
      assert.equal(sourceResult?.role, "tool");
      assert.match(sourceResult?.content ?? "", /"deployable":true/);
      this.readSourceBeforePlan = true;
      return {
        content: null,
        toolCalls: [
          {
            id: "search-capabilities",
            name: "capabilities_search",
            arguments: { query: "create deploy application from source" },
          },
        ],
      };
    }
    const searchResult = messages.at(-1);
    assert.equal(searchResult?.role, "tool");
    assert.match(searchResult?.content ?? "", /apps\.createFromSource/);
    this.searchedCapabilitiesBeforePlan = true;
    const system = messages.find((message) => message.role === "system")?.content ?? "";
    const expiresAt = /expiresAt exactly (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)/.exec(
      system,
    )?.[1];
    assert.ok(expiresAt, "planner policy did not contain the server-owned expiry");
    return {
      content: null,
      toolCalls: [
        {
          id: "propose-deployment",
          name: "propose_plan",
          arguments: {
            plan: {
              schemaVersion: 1,
              goal: `Deploy ${this.name}`,
              summary:
                "Create a new application from the inspected public repository and queue its first deployment.",
              scope: { type: "global", id: null },
              steps: [
                {
                  id: "create-and-deploy",
                  capabilityId: "apps.createFromSource",
                  capabilityVersion: 1,
                  title: "Create and deploy Kitsy",
                  input: {
                    sourceProvider: "github",
                    name: this.name,
                    kind: "web",
                    repositoryUrl: this.repository,
                    branch: "master",
                    flakeOutput: "default",
                    autoDeploy: true,
                    healthPath: "/",
                  },
                  resourceKeys: [`app-name:${this.hash(this.name.toLowerCase()).slice(0, 24)}`],
                  dependsOn: [],
                  risk: "mutation",
                  expectedEffect:
                    "A distinct Kitsy application is created and its initial deployment is queued.",
                  externalWait: false,
                },
              ],
              warnings: ["Repository build code runs as the Nix Ship OS account."],
              expectedResult: "The distinct Kitsy application has a persisted initial deployment.",
              expiresAt,
            },
          },
        },
      ],
    };
  }
}

async function waitForDeployment(
  db: ReturnType<typeof database.getDb>,
  deploymentId: string,
  timeoutMs: number,
): Promise<{ id: string; state: string; failure_message: string | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const deployment = db
      .prepare("SELECT id, state, failure_message FROM deployments WHERE id = ?")
      .get(deploymentId) as { id: string; state: string; failure_message: string | null };
    if (deployment.state === "running") return deployment;
    if (["failed", "cancelled", "interrupted", "superseded"].includes(deployment.state)) {
      throw new Error(
        `AI deployment entered ${deployment.state}: ${deployment.failure_message ?? "unknown error"}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`AI deployment ${deploymentId} did not become healthy before timeout`);
}

await runTest();
