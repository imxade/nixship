import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

const repositoryUrl = process.env.PUBLIC_TEST_REPOSITORY_URL?.trim();
if (!repositoryUrl || !/^https:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?$/i.test(repositoryUrl)) {
  throw new Error("Set PUBLIC_TEST_REPOSITORY_URL to a dedicated public GitHub test repository");
}
if (process.env.PUBLIC_TEST_PUSH !== "1") {
  throw new Error("Set PUBLIC_TEST_PUSH=1 to acknowledge that this test pushes a marker commit");
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "platform-public-github-"));
const pusher = path.join(root, "pusher");
process.env.PLATFORM_DATA_DIR = path.join(root, "data");
process.env.PLATFORM_MASTER_KEY = Buffer.alloc(32, 37).toString("base64");
process.env.MIN_FREE_DISK_MB = "128";
process.env.MIN_FREE_MEMORY_MB = "64";
process.env.SOURCE_POLL_SECONDS = "15";
process.env.METRICS_INTERVAL_SECONDS = "2";
process.env.QUICK_TUNNEL_RECONCILE_SECONDS = "5";

const [{ PlatformRuntime }, database, appService] = await Promise.all([
  import("../../src/server/runtime.ts"),
  import("../../src/server/db.ts"),
  import("../../src/server/app-service.ts"),
]);

let runtime: InstanceType<typeof PlatformRuntime> | null = null;
let appId: string | null = null;

try {
  run("git", ["clone", repositoryUrl, pusher]);
  git(pusher, ["config", "user.name", "Nix Ship push redeployment test"]);
  git(pusher, ["config", "user.email", "platform-test@users.noreply.github.com"]);
  const branch = git(pusher, ["branch", "--show-current"]).trim();
  assert.ok(branch, "The public fixture clone did not select its remote default branch");
  const firstCommit = git(pusher, ["rev-parse", "HEAD"]).trim();

  runtime = new PlatformRuntime();
  await runtime.boot();
  const application = await appService.createApplication({
    name: "Public GitHub redeployment fixture",
    repositoryUrl,
    flakeOutput: "default",
    kind: "web",
    healthPath: "/health",
    autoDeploy: true,
  });
  appId = application.id;
  assert.equal(application.branch, branch);
  assert.ok(application.public_port);
  await runtime.proxy.reconcile();

  const first = appService.queueDeployment(application.id, {
    trigger: "manual",
    commitSha: firstCommit,
    requestedRef: firstCommit,
  });
  const firstRunning = await waitForCommit(application.id, firstCommit, 180_000);
  assert.equal(firstRunning.id, first.id);
  assert.equal(firstRunning.state, "running");
  await assertHealthy(application.public_port);
  await runtime.quickTunnels.reconcile();
  const firstQuickUrl = await waitForDeploymentQuickTunnel(runtime, first.id, 120_000);
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  await assertPublicHealthy(firstQuickUrl, 180_000);

  const marker = new Date().toISOString();
  fs.writeFileSync(path.join(pusher, ".platform-redeploy-marker"), `${marker}\n`);
  git(pusher, ["add", ".platform-redeploy-marker"]);
  git(pusher, ["commit", "-m", `test: verify Nix Ship push redeployment ${marker}`]);
  const pushedCommit = git(pusher, ["rev-parse", "HEAD"]).trim();
  assert.notEqual(pushedCommit, firstCommit);
  const pushedAt = Date.now();
  git(pusher, ["push", "origin", `HEAD:${branch}`]);

  const redeployed = await waitForCommit(application.id, pushedCommit, 240_000);
  assert.equal(redeployed.state, "running");
  assert.equal(redeployed.trigger, "reconcile");
  const active = database
    .getDb()
    .prepare("SELECT active_deployment_id FROM applications WHERE id = ?")
    .get(application.id) as { active_deployment_id: string };
  assert.equal(active.active_deployment_id, redeployed.id);
  assert.equal(
    (
      database.getDb().prepare("SELECT state FROM deployments WHERE id = ?").get(first.id) as {
        state: string;
      }
    ).state,
    "superseded",
  );
  await assertHealthy(application.public_port);
  const redeployedQuickUrl = await waitForDeploymentQuickTunnel(runtime, redeployed.id, 30_000);
  assert.notEqual(redeployedQuickUrl, firstQuickUrl);
  await assertPublicHealthy(redeployedQuickUrl, 120_000);

  console.log(
    JSON.stringify({
      repositoryUrl,
      branch,
      initialCommit: firstCommit,
      pushedCommit,
      pushTriggeredRedeployment: true,
      automaticPollingDetectedPush: true,
      redeploymentSeconds: Math.round((Date.now() - pushedAt) / 1000),
      exactCommitActivated: true,
      stableProxyHealthy: true,
      quickTunnelUrl: redeployedQuickUrl,
      quickTunnelHealthy: true,
      independentDeploymentQuickTunnel: true,
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

function run(command: string, arguments_: string[]): string {
  return execFileSync(command, arguments_, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function git(repository: string, arguments_: string[]): string {
  return run("git", ["-C", repository, ...arguments_]);
}

async function waitForCommit(
  applicationId: string,
  commit: string,
  timeoutMs: number,
): Promise<{ id: string; state: string; trigger: string; failure_message: string | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const deployment = database
      .getDb()
      .prepare(
        `SELECT id, state, trigger, failure_message
         FROM deployments
         WHERE app_id = ? AND commit_sha = ?
         ORDER BY queued_at DESC
         LIMIT 1`,
      )
      .get(applicationId, commit) as
      | { id: string; state: string; trigger: string; failure_message: string | null }
      | undefined;
    if (deployment?.state === "running") return deployment;
    if (
      deployment &&
      ["failed", "cancelled", "interrupted", "superseded"].includes(deployment.state)
    ) {
      throw new Error(
        `${commit} entered ${deployment.state}: ${deployment.failure_message ?? "unknown"}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Commit ${commit} did not become active within ${timeoutMs}ms`);
}

async function assertHealthy(publicPort: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${publicPort}/health`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /"status":"ok"/);
}

async function waitForDeploymentQuickTunnel(
  activeRuntime: InstanceType<typeof PlatformRuntime>,
  deploymentId: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await activeRuntime.quickTunnels.reconcile();
    const route = activeRuntime.quickTunnels.deploymentRoute(deploymentId);
    if (route?.running && route.url) return route.url;
    if (route?.status === "error") {
      throw new Error(`Application Quick Tunnel failed: ${route.lastError ?? "unknown error"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Application Quick Tunnel did not become ready within ${timeoutMs}ms`);
}

async function assertPublicHealthy(origin: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  const hostname = new URL(origin).hostname;
  while (Date.now() < deadline) {
    try {
      const response = await requestHealth(`${origin}/health`);
      if (response.status === 200 && /"status":"ok"/.test(response.body)) return;
      lastError = `HTTP ${response.status}: ${response.body.slice(0, 200)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    const publicAddresses = await resolvePublicAddresses(hostname);
    for (const publicAddress of publicAddresses) {
      try {
        const response = await requestHealth(`${origin}/health`, publicAddress);
        if (response.status === 200 && /"status":"ok"/.test(response.body)) return;
        lastError = `HTTP ${response.status}: ${response.body.slice(0, 200)}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Quick Tunnel did not serve the deployed app: ${lastError}`);
}

async function resolvePublicAddresses(hostname: string): Promise<string[]> {
  try {
    const response = await fetch(
      `https://cloudflare-dns.com/dns-query?${new URLSearchParams({ name: hostname, type: "A" })}`,
      {
        signal: AbortSignal.timeout(10_000),
        headers: { accept: "application/dns-json" },
      },
    );
    if (!response.ok) return [];
    const body = (await response.json()) as {
      Answer?: Array<{ type?: number; data?: string }>;
    };
    return [
      ...new Set(
        body.Answer?.filter((answer) => answer.type === 1).map((answer) => answer.data) ?? [],
      ),
    ].filter((address): address is string => Boolean(address));
  } catch {
    return [];
  }
}

function requestHealth(url: string, address?: string): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = https.get(
      target,
      address
        ? {
            createConnection: () =>
              tls.connect({
                host: address,
                port: 443,
                servername: target.hostname,
              }),
          }
        : {},
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.setTimeout(30_000, () => request.destroy(new Error("HTTPS health check timed out")));
    request.once("error", reject);
  });
}
