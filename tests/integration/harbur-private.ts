import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const baseUrl = process.env.HARBUR_TEST_BASE_URL?.trim() || "https://harbur.vercel.app";
const repositoryId = process.env.HARBUR_TEST_REPOSITORY_ID?.trim() || "rb/kitsy";
const integrationToken = process.env.HARBUR_INTEGRATION_READ_TOKEN?.trim();

if (!integrationToken || integrationToken.length < 32) {
  throw new Error("Set HARBUR_INTEGRATION_READ_TOKEN to the Harbur read-only integration token");
}
if (!/^[^/]+\/[^/]+$/.test(repositoryId)) {
  throw new Error("HARBUR_TEST_REPOSITORY_ID must use the owner/repository form");
}

// The consumer needs the token only while connecting. Never let the deployed
// workload inherit either the CI-only name or Harbur's producer-side name.
delete process.env.HARBUR_INTEGRATION_READ_TOKEN;
delete process.env.INTEGRATION_READ_TOKEN;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "platform-harbur-private-"));
process.env.PLATFORM_DATA_DIR = path.join(root, "data");
process.env.PLATFORM_MASTER_KEY = Buffer.alloc(32, 41).toString("base64");
process.env.MIN_FREE_DISK_MB = "128";
process.env.MIN_FREE_MEMORY_MB = "64";
process.env.SOURCE_POLL_SECONDS = "86400";
process.env.METRICS_INTERVAL_SECONDS = "2";
process.env.QUICK_TUNNELS_ENABLED = "false";

const [{ PlatformRuntime }, database, appService, harbur] = await Promise.all([
  import("../../src/server/runtime.ts"),
  import("../../src/server/db.ts"),
  import("../../src/server/app-service.ts"),
  import("../../src/server/harbur.ts"),
]);

let runtime: InstanceType<typeof PlatformRuntime> | null = null;
let appId: string | null = null;

try {
  runtime = new PlatformRuntime();
  await runtime.boot();

  const connection = await harbur.connectHarbur({
    baseUrl,
    token: integrationToken,
    allowPrivateNetwork: false,
  });
  const repositories = await harbur.listHarburRepositories(connection.id);
  const repository = repositories.find((candidate) => candidate.id === repositoryId);
  assert.ok(repository, `Private Harbur repository ${repositoryId} was not returned`);
  assert.equal(repository.visibility, "private");
  assert.ok(repository.latestSnapshot, `${repositoryId} has no deployable snapshot`);
  const revision = repository.latestSnapshot.revision;
  const events = await harbur.pollHarburEvents(harbur.getHarburConnection(connection.id));
  assert.ok(
    events.events.some(
      (event) => event.repositoryId === repository.id && event.revision === revision,
    ),
    `Harbur event feed did not contain ${repository.id} at ${revision}`,
  );

  const application = await appService.createApplication({
    name: "Harbur private Kitsy fixture",
    sourceProvider: "harbur",
    harburConnectionId: connection.id,
    harburRepositoryId: repository.id,
    flakeOutput: "default",
    kind: "web",
    healthPath: "/",
    autoDeploy: true,
  });
  appId = application.id;
  assert.ok(application.public_port);
  await runtime.proxy.reconcile();

  const queued = appService.queueDeployment(application.id, {
    trigger: "manual",
    commitSha: revision,
    requestedRef: revision,
  });
  const deployment = await waitForDeployment(queued.id, 30 * 60_000);
  assert.equal(deployment.commit_sha, revision);
  if (deployment.pid && fs.existsSync(`/proc/${deployment.pid}/environ`)) {
    const workloadEnvironment = fs.readFileSync(`/proc/${deployment.pid}/environ`, "utf8");
    assert.doesNotMatch(
      workloadEnvironment,
      /(?:^|\0)(?:HARBUR_INTEGRATION_READ_TOKEN|INTEGRATION_READ_TOKEN)=/,
    );
  }

  const active = database
    .getDb()
    .prepare("SELECT active_deployment_id FROM applications WHERE id = ?")
    .get(application.id) as { active_deployment_id: string | null };
  assert.equal(active.active_deployment_id, queued.id);

  const response = await fetch(`http://127.0.0.1:${application.public_port}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Kitsy/i);

  const reconciledConnection = harbur.getHarburConnection(connection.id);
  assert.ok(reconciledConnection.event_cursor > 0);
  assert.equal(reconciledConnection.status, "connected");
  const matchingDeployments = database
    .getDb()
    .prepare("SELECT COUNT(*) AS count FROM deployments WHERE app_id = ? AND commit_sha = ?")
    .get(application.id, revision) as { count: number };
  assert.equal(matchingDeployments.count, 1);

  console.log(
    JSON.stringify({
      baseUrl,
      repositoryId: repository.id,
      visibility: repository.visibility,
      revision,
      exactSnapshotActivated: true,
      stableProxyHealthy: true,
      eventRevisionMatched: true,
      duplicateEventSuppressed: true,
      integrationTokenNotInherited: true,
    }),
  );
} finally {
  if (runtime) {
    if (appId) await runtime.stopApplication(appId).catch(() => undefined);
    await runtime.close().catch(() => undefined);
  }
  database.closeDb();
  fs.rmSync(root, { recursive: true, force: true });
}

async function waitForDeployment(
  deploymentId: string,
  timeoutMs: number,
): Promise<{
  state: string;
  commit_sha: string | null;
  failure_message: string | null;
  pid: number | null;
}> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const deployment = database
      .getDb()
      .prepare("SELECT state, commit_sha, failure_message, pid FROM deployments WHERE id = ?")
      .get(deploymentId) as {
      state: string;
      commit_sha: string | null;
      failure_message: string | null;
      pid: number | null;
    };
    if (deployment.state === "running") return deployment;
    if (["failed", "cancelled", "interrupted", "superseded"].includes(deployment.state)) {
      throw new Error(
        `${deploymentId} entered ${deployment.state}: ${deployment.failure_message ?? "unknown"}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Deployment ${deploymentId} did not become healthy within ${timeoutMs}ms`);
}
