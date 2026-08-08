import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "platform-examples-"));
process.env.PLATFORM_DATA_DIR = path.join(root, "data");
process.env.PLATFORM_MASTER_KEY = Buffer.alloc(32, 17).toString("base64");
process.env.MIN_FREE_DISK_MB = "128";
process.env.MIN_FREE_MEMORY_MB = "64";
process.env.SOURCE_POLL_SECONDS = "86400";
process.env.METRICS_INTERVAL_SECONDS = "2";

const [{ PlatformRuntime }, database, appService, ports] = await Promise.all([
  import("../../src/server/runtime.ts"),
  import("../../src/server/db.ts"),
  import("../../src/server/app-service.ts"),
  import("../../src/server/ports.ts"),
]);

const examples = [
  {
    name: "hello-flake",
    healthPath: "/",
    expectedBody: "Hello from Nix Ship",
  },
  {
    name: "npm-start-flake",
    healthPath: "/health",
    expectedBody: '"app":"npm-start-flake"',
  },
] as const;

let runtime: InstanceType<typeof PlatformRuntime> | null = null;
const appIds: string[] = [];

try {
  runtime = new PlatformRuntime();
  await runtime.boot();

  for (const example of examples) {
    const repository = createExampleRepository(example.name);
    const commit = git(repository, ["rev-parse", "HEAD"]).trim();
    const appId = crypto.randomUUID();
    appIds.push(appId);
    const publicPort = await ports.allocatePublicPort();
    const now = new Date().toISOString();

    database
      .getDb()
      .prepare(
        `INSERT INTO applications(
          id, name, slug, kind, repository_url, branch, flake_output, auto_deploy,
          desired_state, restart_policy, health_path, health_timeout_seconds,
          startup_timeout_seconds, public_port, created_at, updated_at
        ) VALUES (?, ?, ?, 'web', ?, 'fixture-head', 'default', 0, 'running',
          'on-failure', ?, 3, 120, ?, ?, ?)`,
      )
      .run(appId, example.name, example.name, repository, example.healthPath, publicPort, now, now);
    await runtime.proxy.reconcile();

    const queued = appService.queueDeployment(appId, {
      trigger: "manual",
      commitSha: commit,
      requestedRef: commit,
    });
    const deployment = await waitForDeployment(queued.id, 180_000);
    assert.equal(deployment.commit_sha, commit);

    const response = await fetch(`http://127.0.0.1:${publicPort}${example.healthPath}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), new RegExp(example.expectedBody));

    await runtime.stopApplication(appId);
  }

  console.log(
    JSON.stringify({
      directExampleDeployments: examples.map((example) => example.name),
      frontendRequired: false,
      exactCommits: true,
      healthChecks: true,
    }),
  );
} finally {
  if (runtime) {
    for (const appId of appIds) {
      await runtime.stopApplication(appId).catch(() => undefined);
    }
    await runtime.close().catch(() => undefined);
  }
  database.closeDb();
  fs.rmSync(root, { recursive: true, force: true });
}

function createExampleRepository(name: string): string {
  const sourcePrefix = `examples/${name}/`;
  const target = path.join(root, "repositories", name);
  fs.mkdirSync(target, { recursive: true });
  const trackedFiles = execFileSync("git", ["ls-files", sourcePrefix], {
    cwd: process.cwd(),
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.ok(trackedFiles.length > 0, `No tracked files found for ${name}`);
  for (const trackedFile of trackedFiles) {
    const relative = trackedFile.slice(sourcePrefix.length);
    const destination = path.join(target, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(process.cwd(), trackedFile), destination);
  }
  execFileSync("git", ["init", "--initial-branch=fixture-head", target], { stdio: "ignore" });
  git(target, ["config", "user.email", "examples@platform.invalid"]);
  git(target, ["config", "user.name", "Nix Ship examples"]);
  git(target, ["add", "."]);
  git(target, ["commit", "-m", `test ${name}`]);
  return target;
}

function git(repository: string, arguments_: string[]): string {
  return execFileSync("git", ["-C", repository, ...arguments_], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForDeployment(
  deploymentId: string,
  timeoutMs: number,
): Promise<{ state: string; commit_sha: string | null; failure_message: string | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const deployment = database
      .getDb()
      .prepare("SELECT state, commit_sha, failure_message FROM deployments WHERE id = ?")
      .get(deploymentId) as {
      state: string;
      commit_sha: string | null;
      failure_message: string | null;
    };
    if (deployment.state === "running") return deployment;
    if (["failed", "cancelled", "interrupted"].includes(deployment.state)) {
      throw new Error(
        `${deploymentId} entered ${deployment.state}: ${deployment.failure_message ?? "unknown"}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Deployment ${deploymentId} did not become healthy within ${timeoutMs}ms`);
}
