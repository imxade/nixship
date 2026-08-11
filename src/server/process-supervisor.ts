import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { queueDeployment } from "./app-service.ts";
import { spawnLogged } from "./command.ts";
import { decryptSecret } from "./crypto.ts";
import { getDb, nowIso } from "./db.ts";
import { events } from "./events.ts";
import { logger } from "./logger.ts";
import { appPaths } from "./paths.ts";
import {
  captureProcessIdentity,
  matchesProcessIdentity,
  type ProcessIdentity,
} from "./process-identity.ts";
import type { AppRow, DeploymentRow } from "./types.ts";

interface ManagedProcess {
  deploymentId: string;
  appId: string;
  child: ChildProcess;
  expectedStop: boolean;
  identity: ProcessIdentity;
}

export class ProcessSupervisor {
  private readonly managed = new Map<string, ManagedProcess>();
  private monitorTimer: NodeJS.Timeout | null = null;

  boot(): void {
    this.monitorTimer = setInterval(() => void this.reconcile(), 5000);
    this.monitorTimer.unref();
    void this.reconcile();
  }

  async close(): Promise<void> {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
  }

  startCandidate(
    app: AppRow,
    deployment: DeploymentRow,
    releaseDir: string,
    internalPort: number | null,
  ): { child: ChildProcess; identity: ProcessIdentity } {
    const locations = appPaths(app.id, deployment.id);
    const stdoutPath = path.join(locations.logs, `${deployment.id}.stdout.log`);
    const stderrPath = path.join(locations.logs, `${deployment.id}.stderr.log`);
    fs.writeFileSync(
      path.join(locations.logs, `${deployment.id}.meta.json`),
      JSON.stringify({ appId: app.id, deploymentId: deployment.id }, null, 2),
      { mode: 0o600 },
    );
    const envRows = getDb()
      .prepare("SELECT key, value_encrypted FROM app_environment WHERE app_id = ?")
      .all(app.id) as Array<{ key: string; value_encrypted: string }>;
    const env: NodeJS.ProcessEnv = {
      ...workloadBaseEnvironment(process.env),
      ...Object.fromEntries(envRows.map((row) => [row.key, decryptSecret(row.value_encrypted)])),
      MANAGED_DEPLOYMENT: "1",
      APP_ID: app.id,
      APP_NAME: app.name,
      DEPLOYMENT_ID: deployment.id,
      RELEASE_DIR: releaseDir,
      DATA_DIR: locations.data,
      CACHE_DIR: locations.cache,
      LOG_DIR: locations.logs,
      HOST: "127.0.0.1",
      ...(internalPort ? { PORT: String(internalPort) } : {}),
    };
    const child = spawnLogged("nix", ["run", "--no-write-lock-file", `.#${app.flake_output}`], {
      cwd: releaseDir,
      env,
      stdoutPath,
      stderrPath,
      detached: true,
    });
    if (!child.pid) throw new Error("Nix did not return a process ID");
    const identity = captureProcessIdentity(child.pid);
    if (!identity) {
      terminateProcessGroup(child.pid, "SIGKILL");
      throw new Error("Unable to establish a safe identity for the application process");
    }
    child.unref();
    const managed: ManagedProcess = {
      deploymentId: deployment.id,
      appId: app.id,
      child,
      expectedStop: false,
      identity,
    };
    this.managed.set(deployment.id, managed);
    child.once("exit", (code, signal) => this.handleExit(managed, code, signal));
    return { child, identity };
  }

  async stopDeployment(deploymentId: string, graceMs = 10_000): Promise<void> {
    const deployment = getDb()
      .prepare("SELECT * FROM deployments WHERE id = ?")
      .get(deploymentId) as DeploymentRow | undefined;
    if (!deployment?.process_group_id) return;

    const managed = this.managed.get(deploymentId);
    if (managed) managed.expectedStop = true;
    if (!this.isAlive(deployment)) {
      this.managed.delete(deploymentId);
      return;
    }

    terminateProcessGroup(deployment.process_group_id, "SIGTERM");
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && this.isAlive(deployment)) {
      await delay(250);
    }
    if (this.isAlive(deployment)) {
      terminateProcessGroup(deployment.process_group_id, "SIGKILL");
    }
    this.managed.delete(deploymentId);
  }

  refreshIdentity(deploymentId: string): ProcessIdentity {
    const managed = this.managed.get(deploymentId);
    if (!managed?.child.pid || managed.child.exitCode !== null) {
      throw new Error("Application process is no longer running");
    }
    const identity = captureProcessIdentity(managed.child.pid);
    if (!identity?.startTicks || !identity.commandHash) {
      throw new Error("Unable to verify the final application process identity");
    }
    if (identity.startTicks !== managed.identity.startTicks) {
      throw new Error("Application process identity changed unexpectedly during startup");
    }
    managed.identity = identity;
    return identity;
  }

  isAlive(deployment: DeploymentRow): boolean {
    const managed = this.managed.get(deployment.id);
    if (
      managed?.child.pid === deployment.pid &&
      managed.child.exitCode === null &&
      managed.identity.startTicks === deployment.process_start_ticks
    ) {
      return true;
    }
    return matchesProcessIdentity(deployment);
  }

  private async reconcile(): Promise<void> {
    const deployments = getDb()
      .prepare(
        `SELECT d.*
         FROM deployments d
         JOIN applications a ON a.id = d.app_id
         WHERE d.state = 'running' AND a.desired_state = 'running'
         ORDER BY d.activated_at DESC, d.queued_at DESC, d.id DESC`,
      )
      .all() as DeploymentRow[];
    for (const deployment of deployments) {
      if (this.isAlive(deployment)) continue;
      const app = getDb()
        .prepare("SELECT * FROM applications WHERE id = ?")
        .get(deployment.app_id) as AppRow | undefined;
      if (!app) continue;
      const wasProduction = app.active_deployment_id === deployment.id;
      getDb().transaction(() => {
        if (wasProduction) {
          getDb()
            .prepare(
              "UPDATE applications SET active_internal_port = NULL, active_deployment_id = NULL, updated_at = ? WHERE id = ? AND active_deployment_id = ?",
            )
            .run(nowIso(), app.id, deployment.id);
        }
        if (deployment.state === "running") {
          const cleanExit = deployment.exit_code === 0 && !deployment.exit_signal;
          getDb()
            .prepare(
              `UPDATE deployments SET state = 'failed', failure_code = ?, failure_message = ?, finished_at = ?
               WHERE id = ?`,
            )
            .run(
              cleanExit ? "process_exited" : "process_disappeared",
              cleanExit
                ? "The application process exited normally but is no longer serving"
                : "The application process is no longer running or its recorded identity could not be verified",
              nowIso(),
              deployment.id,
            );
        }
      })();
      if (!wasProduction) continue;

      const fallbacks = getDb()
        .prepare(
          `SELECT * FROM deployments WHERE app_id = ? AND state = 'running'
           ORDER BY activated_at DESC, queued_at DESC, id DESC`,
        )
        .all(app.id) as DeploymentRow[];
      const fallback = fallbacks.find((candidate) => this.isAlive(candidate));
      if (fallback) {
        getDb()
          .prepare(
            `UPDATE applications SET active_deployment_id = ?, active_internal_port = ?, updated_at = ?
             WHERE id = ? AND active_deployment_id IS NULL`,
          )
          .run(fallback.id, fallback.internal_port, nowIso(), app.id);
        events.publish("deployment.promoted", `app:${app.id}`, {
          deploymentId: fallback.id,
          reason: "production_process_failed",
        });
        continue;
      }
      const pending = getDb()
        .prepare(
          "SELECT 1 FROM deployments WHERE app_id = ? AND state IN ('queued','preparing','fetching','evaluating','starting','health-checking','activating') LIMIT 1",
        )
        .get(app.id);
      const failed =
        deployment.exit_code === null ||
        deployment.exit_code !== 0 ||
        Boolean(deployment.exit_signal);
      const shouldRestart =
        app.restart_policy === "always" ||
        app.restart_policy === "unless-stopped" ||
        (app.restart_policy === "on-failure" && failed);
      if (!pending && shouldRestart) {
        queueDeployment(app.id, {
          trigger: "restart",
          commitSha: deployment.commit_sha,
          requestedRef: deployment.commit_sha ?? app.branch,
        });
        events.publish("deployment.queued", `app:${app.id}`, { trigger: "restart" });
      } else if (!pending && !shouldRestart) {
        getDb()
          .prepare("UPDATE applications SET desired_state = 'stopped', updated_at = ? WHERE id = ?")
          .run(nowIso(), app.id);
      }
    }
  }

  private handleExit(
    managed: ManagedProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    this.managed.delete(managed.deploymentId);
    getDb()
      .prepare("UPDATE deployments SET exit_code = ?, exit_signal = ? WHERE id = ?")
      .run(code, signal, managed.deploymentId);
    events.publish("process.exit", `app:${managed.appId}`, {
      deploymentId: managed.deploymentId,
      code,
      signal,
      expected: managed.expectedStop,
    });
    if (!managed.expectedStop) {
      logger.warn("Application process exited", {
        deploymentId: managed.deploymentId,
        appId: managed.appId,
        code,
        signal,
      });
    }
  }
}

export function workloadBaseEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !key.toUpperCase().startsWith("PLATFORM_")),
  ) as NodeJS.ProcessEnv;
}

function terminateProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) return;
  try {
    if (process.platform === "win32") process.kill(processGroupId, signal);
    else process.kill(-processGroupId, signal);
  } catch {
    // The process may have exited between identity verification and signalling.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
