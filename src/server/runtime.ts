import fs from "node:fs";
import { applicationDomains, queueDeployment } from "./app-service.ts";
import { audit } from "./audit.ts";
import { ensureSetupToken, purgeExpiredSessions } from "./auth.ts";
import { CloudflareController } from "./cloudflare.ts";
import { getDb, nowIso } from "./db.ts";
import { DeploymentEngine } from "./deployment-engine.ts";
import { errorMessage, HttpError } from "./errors.ts";
import { events } from "./events.ts";
import { GitReconciler } from "./git-reconciler.ts";
import { latestHarburRevision } from "./harbur.ts";
import { HarburReconciler } from "./harbur-reconciler.ts";
import { LogRetentionController } from "./log-retention.ts";
import { logger } from "./logger.ts";
import { MetricsCollector } from "./metrics.ts";
import { ensureDataDirectories, paths } from "./paths.ts";
import { captureProcessIdentity, matchesProcessIdentity } from "./process-identity.ts";
import { ProcessSupervisor } from "./process-supervisor.ts";
import { ProxyManager } from "./proxy-manager.ts";
import { synchronizeGitHubWebhook } from "./public-webhook.ts";
import { QuickTunnelController } from "./quick-tunnels.ts";
import type { AppRow, DeploymentRow, DeploymentState } from "./types.ts";

export type ApplicationOperationalStatus =
  | DeploymentState
  | "stopped"
  | "not-deployed"
  | "unavailable";

export class PlatformRuntime {
  readonly proxy = new ProxyManager();
  readonly supervisor = new ProcessSupervisor();
  readonly metrics = new MetricsCollector();
  readonly cloudflare = new CloudflareController();
  readonly quickTunnels = new QuickTunnelController();
  readonly deployments = new DeploymentEngine(this.supervisor, this.proxy, this.quickTunnels);
  readonly git = new GitReconciler();
  readonly harbur = new HarburReconciler();
  readonly logRetention = new LogRetentionController();
  private maintenanceTimer: NodeJS.Timeout | null = null;
  private closed = false;

  async boot(): Promise<void> {
    ensureDataDirectories();
    acquireRuntimeLock();
    getDb();
    ensureSetupToken();
    await recoverDesiredState(this.supervisor);
    await this.proxy.reconcile();
    this.supervisor.boot();
    this.metrics.boot();
    await this.deployments.boot();
    this.git.boot();
    this.harbur.boot();
    this.logRetention.boot();
    await this.cloudflare.boot();
    await this.quickTunnels.boot();
    void synchronizeGitHubWebhook().catch(() => undefined);
    this.maintenanceTimer = setInterval(() => this.maintenance(), 60_000);
    this.maintenanceTimer.unref();
    events.publish("runtime.ready", "system", { pid: process.pid, dataDir: paths.data });
    logger.info("Nix Ship runtime ready", { pid: process.pid, dataDir: paths.data });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.git.close();
    this.harbur.close();
    this.logRetention.close();
    this.metrics.close();
    await this.deployments.close();
    await this.supervisor.close();
    await this.proxy.close();
    await this.quickTunnels.close();
    this.cloudflare.close();
    releaseRuntimeLock();
  }

  applicationOperationalStatus(appId: string): ApplicationOperationalStatus {
    const app = getDb().prepare("SELECT * FROM applications WHERE id = ?").get(appId) as
      | AppRow
      | undefined;
    if (!app) throw new Error("Application not found");
    if (app.desired_state === "stopped") return "stopped";

    if (app.active_deployment_id) {
      const active = getDb()
        .prepare("SELECT * FROM deployments WHERE id = ?")
        .get(app.active_deployment_id) as DeploymentRow | undefined;
      if (active?.state === "running") {
        return this.supervisor.isAlive(active) ? "running" : "unavailable";
      }
    }

    const latest = getDb()
      .prepare("SELECT * FROM deployments WHERE app_id = ? ORDER BY queued_at DESC LIMIT 1")
      .get(appId) as DeploymentRow | undefined;
    return latest?.state ?? "not-deployed";
  }

  async stopApplication(appId: string): Promise<void> {
    const app = getDb().prepare("SELECT * FROM applications WHERE id = ?").get(appId) as
      | AppRow
      | undefined;
    if (!app) throw new Error("Application not found");
    const stoppedAt = nowIso();
    getDb()
      .prepare("UPDATE applications SET desired_state = 'stopped', updated_at = ? WHERE id = ?")
      .run(stoppedAt, appId);

    const candidates = getDb()
      .prepare(
        `SELECT id FROM deployments WHERE app_id = ? AND state IN
         ('queued','preparing','fetching','evaluating','starting','health-checking','activating')`,
      )
      .all(appId) as Array<{ id: string }>;
    for (const candidate of candidates) this.deployments.cancel(candidate.id);

    const running = getDb()
      .prepare("SELECT id FROM deployments WHERE app_id = ? AND state = 'running' ORDER BY id")
      .all(appId) as Array<{ id: string }>;
    getDb().transaction(() => {
      getDb()
        .prepare(
          "UPDATE deployments SET state = 'superseded', finished_at = ? WHERE app_id = ? AND state = 'running'",
        )
        .run(stoppedAt, appId);
      getDb()
        .prepare(
          "UPDATE applications SET active_internal_port = NULL, active_deployment_id = NULL, updated_at = ? WHERE id = ?",
        )
        .run(stoppedAt, appId);
    })();
    for (const deployment of running) await this.supervisor.stopDeployment(deployment.id);
    await this.proxy.reconcile();
    await this.quickTunnels.reconcile();
    events.publish("application.stopped", `app:${appId}`, {});
  }

  async promoteDeployment(
    deploymentId: string,
    actor?: { id: string; ip?: string | null },
  ): Promise<void> {
    const deployment = getDb()
      .prepare(
        `SELECT d.*, a.kind AS app_kind, a.desired_state AS app_desired_state
         FROM deployments d JOIN applications a ON a.id = d.app_id
         WHERE d.id = ?`,
      )
      .get(deploymentId) as
      | (DeploymentRow & { app_kind: string; app_desired_state: string })
      | undefined;
    if (!deployment) throw new HttpError(404, "Deployment not found", "deployment_not_found");
    if (
      deployment.state !== "running" ||
      deployment.app_kind !== "web" ||
      deployment.app_desired_state !== "running" ||
      !deployment.internal_port ||
      !this.supervisor.isAlive(deployment)
    ) {
      throw new HttpError(
        409,
        "Only an active, healthy web deployment can be promoted",
        "deployment_not_promotable",
      );
    }
    if (applicationDomains(deployment.app_id).length === 0) {
      throw new HttpError(
        409,
        "Configure a production domain for this project before promoting a deployment",
        "production_domain_required",
      );
    }
    const previous = getDb()
      .prepare("SELECT active_deployment_id, active_internal_port FROM applications WHERE id = ?")
      .get(deployment.app_id) as {
      active_deployment_id: string | null;
      active_internal_port: number | null;
    };
    const promotedAt = nowIso();
    const result = getDb()
      .prepare(
        `UPDATE applications SET active_deployment_id = ?, active_internal_port = ?, updated_at = ?
         WHERE id = ? AND desired_state = 'running'`,
      )
      .run(deployment.id, deployment.internal_port, promotedAt, deployment.app_id);
    if (result.changes !== 1) {
      throw new HttpError(409, "The project stopped during promotion", "promotion_conflict");
    }
    if (!this.supervisor.isAlive(deployment)) {
      getDb()
        .prepare(
          `UPDATE applications SET active_deployment_id = ?, active_internal_port = ?, updated_at = ?
           WHERE id = ? AND active_deployment_id = ?`,
        )
        .run(
          previous.active_deployment_id,
          previous.active_internal_port,
          nowIso(),
          deployment.app_id,
          deployment.id,
        );
      throw new HttpError(
        409,
        "The selected deployment stopped during promotion; production was left unchanged",
        "promotion_process_stopped",
      );
    }
    audit({
      userId: actor?.id,
      ip: actor?.ip,
      action: "deployment.promoted",
      entityType: "deployment",
      entityId: deployment.id,
      details: { appId: deployment.app_id },
    });
    events.publish("deployment.promoted", `app:${deployment.app_id}`, {
      deploymentId: deployment.id,
    });
  }

  async startApplication(appId: string): Promise<DeploymentRow> {
    const app = getDb().prepare("SELECT * FROM applications WHERE id = ?").get(appId) as
      | AppRow
      | undefined;
    if (!app) throw new Error("Application not found");
    getDb()
      .prepare("UPDATE applications SET desired_state = 'running', updated_at = ? WHERE id = ?")
      .run(nowIso(), appId);
    const latest = getDb()
      .prepare(
        `SELECT * FROM deployments
         WHERE app_id = ? AND commit_sha IS NOT NULL AND activated_at IS NOT NULL
         ORDER BY activated_at DESC LIMIT 1`,
      )
      .get(appId) as DeploymentRow | undefined;
    const commitSha =
      latest?.commit_sha ??
      (app.source_provider === "harbur" ? await latestHarburRevision(app) : null);
    return queueDeployment(appId, {
      trigger: "restart",
      commitSha,
      requestedRef: commitSha ?? app.branch,
    });
  }

  async restartApplication(appId: string): Promise<DeploymentRow> {
    await this.stopApplication(appId);
    return this.startApplication(appId);
  }

  private maintenance(): void {
    purgeExpiredSessions();
    const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
    getDb().prepare("DELETE FROM webhook_deliveries WHERE received_at < ?").run(cutoff);
    void synchronizeGitHubWebhook().catch(() => undefined);
  }
}

declare global {
  var __platformRuntimePromise: Promise<PlatformRuntime> | undefined;
}

export function bootRuntime(): Promise<PlatformRuntime> {
  if (!globalThis.__platformRuntimePromise) {
    const runtime = new PlatformRuntime();
    globalThis.__platformRuntimePromise = runtime
      .boot()
      .then(() => runtime)
      .catch((error) => {
        globalThis.__platformRuntimePromise = undefined;
        throw error;
      });
  }
  return globalThis.__platformRuntimePromise;
}

export async function getRuntime(): Promise<PlatformRuntime> {
  return bootRuntime();
}

async function recoverDesiredState(supervisor: ProcessSupervisor): Promise<void> {
  const apps = getDb()
    .prepare("SELECT * FROM applications WHERE desired_state = 'running'")
    .all() as AppRow[];
  for (const app of apps) {
    const running = getDb()
      .prepare(
        `SELECT * FROM deployments WHERE app_id = ? AND state = 'running'
         ORDER BY activated_at DESC, queued_at DESC, id DESC`,
      )
      .all(app.id) as DeploymentRow[];
    const active = running.find((deployment) => deployment.id === app.active_deployment_id);
    if (active && supervisor.isAlive(active)) continue;
    const fallback = running.find((deployment) => supervisor.isAlive(deployment));
    if (fallback) {
      getDb()
        .prepare(
          `UPDATE applications SET active_deployment_id = ?, active_internal_port = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(fallback.id, fallback.internal_port, nowIso(), app.id);
      continue;
    }
    const pending = getDb()
      .prepare(
        `SELECT 1 FROM deployments WHERE app_id = ? AND state IN
         ('queued','preparing','fetching','evaluating','starting','health-checking','activating') LIMIT 1`,
      )
      .get(app.id);
    if (!pending) {
      let commitSha = recoveryRevision(app, running);
      if (app.source_provider === "harbur" && !commitSha) {
        try {
          commitSha = await latestHarburRevision(app);
        } catch (error) {
          logger.warn("Harbur recovery revision could not be resolved", {
            appId: app.id,
            error: errorMessage(error),
          });
          continue;
        }
      }
      queueDeployment(app.id, {
        trigger: "restart",
        commitSha,
        requestedRef: commitSha ?? app.branch,
      });
    }
  }
}

export function recoveryRevision(
  app: Pick<AppRow, "source_provider">,
  deployments: Array<Pick<DeploymentRow, "commit_sha">>,
) {
  if (app.source_provider !== "harbur") return null;
  return deployments.find((deployment) => deployment.commit_sha)?.commit_sha ?? null;
}

function acquireRuntimeLock(): void {
  const lockPath = `${paths.runtime}/runtime.lock`;
  if (fs.existsSync(lockPath)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
        pid?: number;
        processGroupId?: number;
        startTicks?: string | null;
        commandHash?: string | null;
        commandSummary?: string | null;
      };
      if (
        lock.pid &&
        lock.pid !== process.pid &&
        matchesProcessIdentity({
          pid: lock.pid,
          process_group_id: lock.processGroupId ?? lock.pid,
          process_start_ticks: lock.startTicks ?? null,
          process_command_hash: lock.commandHash ?? null,
          process_command_summary: lock.commandSummary ?? null,
        })
      ) {
        throw new Error(`Another Nix Ship control plane is already running with PID ${lock.pid}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Another Nix Ship")) throw error;
    }
    fs.rmSync(lockPath, { force: true });
  }

  const identity = captureProcessIdentity(process.pid);
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      processGroupId: identity?.processGroupId ?? process.pid,
      startTicks: identity?.startTicks ?? null,
      commandHash: identity?.commandHash ?? null,
      commandSummary: identity?.commandSummary ?? null,
      startedAt: nowIso(),
    }),
    { mode: 0o600, flag: "wx" },
  );
}

function releaseRuntimeLock(): void {
  const lockPath = `${paths.runtime}/runtime.lock`;
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: number };
    if (lock.pid === process.pid) fs.rmSync(lockPath, { force: true });
  } catch {
    // A missing or malformed lock is not recoverable during shutdown.
  }
}
