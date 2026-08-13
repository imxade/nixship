import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "platform-deployment-"));
const repository = path.join(root, "repository");
const nixSystem = execFileSync(
  "nix",
  ["eval", "--impure", "--raw", "--expr", "builtins.currentSystem"],
  { encoding: "utf8" },
).trim();
process.env.PLATFORM_DATA_DIR = path.join(root, "data");
process.env.PLATFORM_MASTER_KEY = Buffer.alloc(32, 11).toString("base64");
process.env.MIN_FREE_DISK_MB = "128";
process.env.MIN_FREE_MEMORY_MB = "64";
process.env.SOURCE_POLL_SECONDS = "86400";
process.env.METRICS_INTERVAL_SECONDS = "2";
process.env.HOST_ONLY_SECRET_SENTINEL = "must-not-reach-workload";

const [{ PlatformRuntime }, database, appService, environment, ports, processIdentity] =
  await Promise.all([
    import("../../src/server/runtime.ts"),
    import("../../src/server/db.ts"),
    import("../../src/server/app-service.ts"),
    import("../../src/server/environment.ts"),
    import("../../src/server/ports.ts"),
    import("../../src/server/process-identity.ts"),
  ]);

let runtime: InstanceType<typeof PlatformRuntime> | null = null;
const appId = crypto.randomUUID();
try {
  createFixtureRepository(repository, 200, "v1");
  const firstCommit = git(repository, ["rev-parse", "HEAD"]).trim();
  runtime = new PlatformRuntime();
  await runtime.boot();

  const publicPort = await ports.allocatePublicPort();
  const now = new Date().toISOString();
  database
    .getDb()
    .prepare(
      `INSERT INTO applications(
        id, name, slug, kind, repository_url, branch, flake_output, auto_deploy,
        desired_state, restart_policy, health_path, health_timeout_seconds,
        startup_timeout_seconds, public_port, created_at, updated_at
      ) VALUES (?, 'Fixture', 'fixture', 'web', ?, 'main', 'default', 1, 'running',
        'on-failure', '/health', 2, 10, ?, ?, ?)`,
    )
    .run(appId, repository, publicPort, now, now);
  const expectedEnvironment = {
    FIXTURE_PLAIN: "alpha",
    FIXTURE_SPACED: "two words",
    FIXTURE_EQUALS: "left=right",
    FIXTURE_HASH: "literal # hash",
    FIXTURE_MULTILINE: "first\nsecond",
    FIXTURE_EMPTY: "",
    HOST_ONLY_SECRET_SENTINEL: null,
  };
  appService.setEnvironment(
    appId,
    environment.parseEnvironmentText(`
# A complete dotenv paste is parsed, encrypted, stored and launched as separate values.
FIXTURE_PLAIN=alpha
FIXTURE_SPACED="two words"
FIXTURE_EQUALS=left=right
FIXTURE_HASH='literal # hash'
FIXTURE_MULTILINE="first
second"
FIXTURE_EMPTY=
`),
  );
  await runtime.proxy.reconcile();

  const first = appService.queueDeployment(appId, {
    trigger: "manual",
    commitSha: firstCommit,
    requestedRef: firstCommit,
  });
  const running = await waitForDeployment(database.getDb(), first.id, ["running"], 120_000);
  assert.equal(running.state, "running");
  assert.ok(running.pid);
  assert.ok(running.process_group_id);
  assert.ok(running.process_start_ticks);
  assert.ok(running.process_command_hash);
  assert.ok(processIdentity.matchesProcessIdentity(running));
  assert.equal(await responseText(publicPort), "v1");
  assert.deepEqual(JSON.parse(await responseText(publicPort, "/environment")), expectedEnvironment);

  createFixtureRepository(repository, 500, "v2");
  const secondCommit = git(repository, ["rev-parse", "HEAD"]).trim();
  const second = appService.queueDeployment(appId, {
    trigger: "manual",
    commitSha: secondCommit,
    requestedRef: secondCommit,
  });
  const failed = await waitForDeployment(database.getDb(), second.id, ["failed"], 30_000);
  assert.equal(failed.state, "failed");
  const applicationAfterFailure = database
    .getDb()
    .prepare("SELECT active_deployment_id FROM applications WHERE id = ?")
    .get(appId) as { active_deployment_id: string };
  assert.equal(applicationAfterFailure.active_deployment_id, first.id);
  assert.equal(await responseText(publicPort), "v1");

  await runtime.close();
  runtime = null;
  const queued = [
    appService.queueDeployment(appId, { trigger: "manual", commitSha: firstCommit }),
    appService.queueDeployment(appId, { trigger: "manual", commitSha: firstCommit }),
    appService.queueDeployment(appId, { trigger: "manual", commitSha: firstCommit }),
  ];
  const queuedStates = queued.map(
    (item) =>
      (
        database.getDb().prepare("SELECT state FROM deployments WHERE id = ?").get(item.id) as {
          state: string;
        }
      ).state,
  );
  assert.deepEqual(queuedStates, ["superseded", "superseded", "queued"]);
  database
    .getDb()
    .prepare(
      "UPDATE deployments SET state = 'cancelled', failure_code = 'fixture_cleanup', finished_at = ? WHERE id = ?",
    )
    .run(new Date().toISOString(), queued[2]?.id);

  database.closeDb();
  runtime = new PlatformRuntime();
  await runtime.boot();
  assert.equal(await responseText(publicPort), "v1");
  const restarts = database
    .getDb()
    .prepare("SELECT COUNT(*) AS count FROM deployments WHERE app_id = ? AND trigger = 'restart'")
    .get(appId) as { count: number };
  assert.equal(restarts.count, 0);

  await runtime.stopApplication(appId);
  const unavailable = await fetch(`http://127.0.0.1:${publicPort}/`);
  assert.equal(unavailable.status, 503);
  assert.equal(processIdentity.matchesProcessIdentity(running), false);
  console.log(
    JSON.stringify({
      healthyActivation: true,
      dotenvEnvironmentReachedProcess: true,
      hostEnvironmentSecretExcluded: true,
      failedCandidatePreservedRelease: true,
      queueSuperseding: true,
      recoveredProcessIdentity: true,
      stoppedProcessGroup: true,
    }),
  );
} finally {
  if (runtime) {
    await runtime.stopApplication(appId).catch(() => undefined);
    await runtime.close().catch(() => undefined);
  }
  database.closeDb();
  fs.rmSync(root, { recursive: true, force: true });
}

function createFixtureRepository(target: string, healthStatus: number, version: string): void {
  fs.mkdirSync(target, { recursive: true });
  if (!fs.existsSync(path.join(target, ".git"))) {
    const serverSource = "$" + "{./server.py}";
    execFileSync("git", ["init", "--initial-branch=main", target], { stdio: "ignore" });
    git(target, ["config", "user.email", "fixture@platform.invalid"]);
    git(target, ["config", "user.name", "Nix Ship fixture"]);
    fs.copyFileSync(path.join(process.cwd(), "flake.lock"), path.join(target, "flake.lock"));
    fs.writeFileSync(
      path.join(target, "flake.nix"),
      `{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { self, nixpkgs }:
    let
      system = "${nixSystem}";
      pkgs = import nixpkgs { inherit system; };
      fixture = pkgs.writeShellApplication {
        name = "platform-deployment-fixture";
        runtimeInputs = [ pkgs.python3 pkgs.coreutils ];
        text = "exec python ${serverSource}";
      };
    in {
      apps.\${system}.default = { type = "app"; program = "\${fixture}/bin/platform-deployment-fixture"; };
    };
}
`,
    );
  }
  fs.writeFileSync(
    path.join(target, "server.py"),
    `import http.server
import json
import os
import subprocess

child = subprocess.Popen(["sleep", "3600"])
environment_keys = [
    "FIXTURE_PLAIN",
    "FIXTURE_SPACED",
    "FIXTURE_EQUALS",
    "FIXTURE_HASH",
    "FIXTURE_MULTILINE",
    "FIXTURE_EMPTY",
    "HOST_ONLY_SECRET_SENTINEL",
]

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        status = ${healthStatus} if self.path == "/health" else 200
        body = (
            json.dumps({key: os.environ.get(key) for key in environment_keys}).encode()
            if self.path == "/environment"
            else b"${version}"
        )
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        print(format % args, flush=True)

try:
    http.server.ThreadingHTTPServer(
        (os.environ.get("HOST", "127.0.0.1"), int(os.environ["PORT"])),
        Handler,
    ).serve_forever()
finally:
    child.terminate()
`,
  );
  git(target, ["add", "flake.nix", "flake.lock", "server.py"]);
  git(target, ["commit", "--allow-empty", "-m", version]);
}

function git(repositoryPath: string, arguments_: string[]): string {
  return execFileSync("git", ["-C", repositoryPath, ...arguments_], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForDeployment(
  db: ReturnType<typeof database.getDb>,
  id: string,
  terminalStates: string[],
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const deployment = db.prepare("SELECT * FROM deployments WHERE id = ?").get(id) as {
      state: string;
      failure_message: string | null;
      pid: number | null;
      process_group_id: number | null;
      process_start_ticks: string | null;
      process_command_hash: string | null;
    };
    if (terminalStates.includes(deployment.state)) return deployment;
    if (["failed", "cancelled", "interrupted"].includes(deployment.state)) {
      throw new Error(`Deployment entered ${deployment.state}: ${deployment.failure_message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Deployment ${id} did not reach ${terminalStates.join("/")} in time`);
}

async function responseText(port: number, pathname = "/"): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-platform-application-proxy"), "ready");
  return response.text();
}
