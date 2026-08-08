import type { ChildProcess } from "node:child_process";
import os from "node:os";
import { config } from "./config.ts";
import { getDb, nowIso } from "./db.ts";
import { activeDeploymentLimit } from "./deployment-settings.ts";
import { errorMessage, HttpError } from "./errors.ts";
import { events } from "./events.ts";
import { inspectFlake } from "./flake.ts";
import { prepareRelease, removeReleaseWorktree } from "./git.ts";
import { prepareHarburRelease } from "./harbur.ts";
import { logger } from "./logger.ts";
import { latestHostMetric } from "./metrics.ts";
import { allocateInternalPort } from "./ports.ts";
import type { ProcessSupervisor } from "./process-supervisor.ts";
import type { ProxyManager } from "./proxy-manager.ts";
import type { QuickTunnelController } from "./quick-tunnels.ts";
import type { AppRow, DeploymentRow, DeploymentState } from "./types.ts";

export class DeploymentEngine {
  private timer: NodeJS.Timeout | null = null;
  private active = 0;
  private stopping = false;
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(
    private readonly supervisor: ProcessSupervisor,
    private readonly proxy: ProxyManager,
    private readonly quickTunnels: QuickTunnelController,
  ) {}

  async boot(): Promise<void> {
    const interrupted = getDb()
      .prepare(
        `SELECT * FROM deployments
         WHERE state IN ('preparing','fetching','evaluating','starting','health-checking','activating')`,
      )
      .all() as DeploymentRow[];
    const now = nowIso();
    getDb()
      .prepare(
        `UPDATE deployments SET state = 'interrupted', failure_code = 'control_plane_restarted',
          failure_message = 'The control plane restarted before this deployment completed', finished_at = ?
         WHERE state IN ('preparing','fetching','evaluating','starting','health-checking','activating')`,
      )
      .run(now);
    for (const deployment of interrupted) {
      await this.supervisor.stopDeployment(deployment.id).catch((error) =>
        logger.warn("Interrupted candidate cleanup failed", {
          deploymentId: deployment.id,
          error: errorMessage(error),
        }),
      );
    }
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref();
    void this.tick();
  }

  async close(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const controller of this.abortControllers.values()) controller.abort();
    while (this.active > 0) await delay(100);
  }

  cancel(deploymentId: string): void {
    getDb().transaction(() => {
      getDb().prepare("UPDATE deployments SET cancel_requested = 1 WHERE id = ?").run(deploymentId);
      getDb()
        .prepare(
          `UPDATE deployments SET state = 'cancelled', failure_code = 'cancelled',
            failure_message = 'Deployment was cancelled', finished_at = ?
           WHERE id = ? AND state = 'queued'`,
        )
        .run(nowIso(), deploymentId);
    })();
    this.abortControllers.get(deploymentId)?.abort();
  }

  async enforceActiveDeploymentLimit(appId: string): Promise<string[]> {
    const running = getDb()
      .prepare(
        `SELECT * FROM deployments
         WHERE app_id = ? AND state = 'running'
         ORDER BY activated_at DESC, queued_at DESC, id DESC`,
      )
      .all(appId) as DeploymentRow[];
    const stale = running.slice(activeDeploymentLimit());
    if (stale.length === 0) return [];

    const staleIds = new Set(stale.map((deployment) => deployment.id));
    const survivor = running.find((deployment) => !staleIds.has(deployment.id)) ?? null;
    const app = getDb().prepare("SELECT * FROM applications WHERE id = ?").get(appId) as AppRow;
    const stoppedAt = nowIso();
    getDb().transaction(() => {
      const supersede = getDb().prepare(
        `UPDATE deployments SET state = 'superseded', finished_at = ?
         WHERE id = ? AND state = 'running'`,
      );
      for (const deployment of stale) supersede.run(stoppedAt, deployment.id);
      if (app.active_deployment_id && staleIds.has(app.active_deployment_id)) {
        getDb()
          .prepare(
            `UPDATE applications SET active_deployment_id = ?, active_internal_port = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(survivor?.id ?? null, survivor?.internal_port ?? null, stoppedAt, appId);
      }
    })();
    for (const deployment of stale) {
      await this.supervisor.stopDeployment(deployment.id);
      events.publish("deployment.deactivated", `app:${appId}`, {
        deploymentId: deployment.id,
        reason: "active_deployment_limit",
      });
    }
    await this.proxy.reconcile();
    await this.quickTunnels.reconcile();
    return stale.map((deployment) => deployment.id);
  }

  async enforceActiveDeploymentLimits(): Promise<void> {
    const apps = getDb().prepare("SELECT id FROM applications ORDER BY id").all() as Array<{
      id: string;
    }>;
    for (const app of apps) await this.enforceActiveDeploymentLimit(app.id);
  }

  private async tick(): Promise<void> {
    if (this.stopping || this.active >= config.BUILD_CONCURRENCY) return;
    const deployment = claimDeployment();
    if (!deployment) return;
    this.active++;
    try {
      await this.execute(deployment);
    } finally {
      this.active--;
      queueMicrotask(() => void this.tick());
    }
  }

  private async execute(initial: DeploymentRow): Promise<void> {
    let deployment = initial;
    let app = getDb()
      .prepare("SELECT * FROM applications WHERE id = ?")
      .get(deployment.app_id) as AppRow;
    let child: ChildProcess | null = null;
    let releaseDir: string | null = null;
    let internalPort: number | null = null;
    const abortController = new AbortController();
    this.abortControllers.set(deployment.id, abortController);
    try {
      ensureNotCancelled(deployment.id);
      preflightResources();
      transition(deployment.id, "fetching");
      events.publish("deployment.state", `app:${app.id}`, {
        deploymentId: deployment.id,
        state: "fetching",
      });
      const release =
        app.source_provider === "harbur"
          ? await prepareHarburRelease(
              app,
              deployment.id,
              deployment.commit_sha,
              abortController.signal,
            )
          : await prepareRelease(app, deployment.id, deployment.commit_sha, abortController.signal);
      releaseDir = release.releaseDir;
      getDb()
        .prepare("UPDATE deployments SET commit_sha = ?, release_dir = ? WHERE id = ?")
        .run(release.commit, releaseDir, deployment.id);
      ensureNotCancelled(deployment.id);

      transition(deployment.id, "evaluating");
      events.publish("deployment.state", `app:${app.id}`, {
        deploymentId: deployment.id,
        state: "evaluating",
      });
      await inspectFlake(releaseDir, app.flake_output, abortController.signal);
      ensureNotCancelled(deployment.id);

      internalPort = app.kind === "web" ? await allocateInternalPort() : null;
      transition(deployment.id, "starting", { internalPort });
      deployment = getDeployment(deployment.id);
      const started = this.supervisor.startCandidate(app, deployment, releaseDir, internalPort);
      child = started.child;
      if (!child.pid) throw new Error("Application launcher did not expose a process ID");
      getDb()
        .prepare(
          `UPDATE deployments SET pid = ?, process_group_id = ?, process_start_ticks = ?,
            process_command_hash = ?, process_command_summary = ?, internal_port = ? WHERE id = ?`,
        )
        .run(
          started.identity.pid,
          started.identity.processGroupId,
          started.identity.startTicks,
          started.identity.commandHash,
          started.identity.commandSummary,
          internalPort,
          deployment.id,
        );
      events.publish("deployment.state", `app:${app.id}`, {
        deploymentId: deployment.id,
        state: "starting",
        pid: child.pid,
      });

      transition(deployment.id, "health-checking");
      if (app.kind === "web") {
        if (!internalPort) throw new Error("Web application was not assigned an internal port");
        await waitForHealthy(app, deployment.id, internalPort, child, abortController.signal);
      } else {
        await waitForStableProcess(deployment.id, child, 5000, abortController.signal);
      }
      ensureNotCancelled(deployment.id);
      const finalIdentity = this.supervisor.refreshIdentity(deployment.id);
      getDb()
        .prepare(
          `UPDATE deployments SET process_group_id = ?, process_start_ticks = ?,
            process_command_hash = ?, process_command_summary = ? WHERE id = ?`,
        )
        .run(
          finalIdentity.processGroupId,
          finalIdentity.startTicks,
          finalIdentity.commandHash,
          finalIdentity.commandSummary,
          deployment.id,
        );

      transition(deployment.id, "activating");
      app = getDb().prepare("SELECT * FROM applications WHERE id = ?").get(app.id) as AppRow;
      if (app.desired_state !== "running") {
        throw new HttpError(
          409,
          "Deployment cancelled because the application was stopped",
          "deployment_cancelled",
        );
      }
      ensureNotCancelled(deployment.id);
      const activatedAt = nowIso();
      getDb().transaction(() => {
        getDb()
          .prepare(
            `UPDATE applications SET active_internal_port = ?, active_deployment_id = ?, desired_state = 'running', updated_at = ?
             WHERE id = ?`,
          )
          .run(internalPort, deployment.id, activatedAt, app.id);
        getDb()
          .prepare(
            "UPDATE deployments SET state = 'running', activated_at = ?, failure_code = NULL, failure_message = NULL WHERE id = ?",
          )
          .run(activatedAt, deployment.id);
      })();
      await this.proxy.reconcile();
      await this.enforceActiveDeploymentLimit(app.id);
      await this.quickTunnels.reconcile();
      events.publish("deployment.state", `app:${app.id}`, {
        deploymentId: deployment.id,
        state: "running",
        commit: release.commit,
      });
      logger.info("Deployment activated", {
        appId: app.id,
        deploymentId: deployment.id,
        commit: release.commit,
      });
    } catch (error) {
      const current = getDeployment(deployment.id);
      if (child?.pid && current.state !== "running")
        await this.supervisor.stopDeployment(deployment.id).catch(() => undefined);
      const cancelled =
        Boolean(current.cancel_requested) ||
        abortController.signal.aborted ||
        (error instanceof HttpError && error.code === "deployment_cancelled");
      const resource = classifyResourceFailure(current, error);
      getDb()
        .prepare(
          `UPDATE deployments SET state = ?, failure_code = ?, failure_message = ?, resource_confidence = ?, finished_at = ?
           WHERE id = ? AND state != 'running'`,
        )
        .run(
          cancelled ? "cancelled" : "failed",
          cancelled ? "cancelled" : resource.code,
          cancelled ? "Deployment was cancelled" : errorMessage(error).slice(0, 8000),
          resource.confidence,
          nowIso(),
          deployment.id,
        );
      events.publish("deployment.state", `app:${app.id}`, {
        deploymentId: deployment.id,
        state: cancelled ? "cancelled" : "failed",
        message: cancelled ? "Deployment was cancelled" : errorMessage(error),
        resourceConfidence: resource.confidence,
      });
      logger.error("Deployment failed", {
        appId: app.id,
        deploymentId: deployment.id,
        error: errorMessage(error),
      });
    } finally {
      this.abortControllers.delete(deployment.id);
      await cleanupReleaseWorktrees(app.id).catch((error) =>
        logger.warn("Release cleanup failed", { appId: app.id, error: errorMessage(error) }),
      );
    }
  }
}

async function cleanupReleaseWorktrees(appId: string): Promise<void> {
  const stale = getDb()
    .prepare(
      `SELECT id, release_dir FROM deployments WHERE app_id = ? AND release_dir IS NOT NULL
     AND state != 'running'
     ORDER BY queued_at DESC LIMIT -1 OFFSET ?`,
    )
    .all(appId, config.RELEASE_RETENTION) as Array<{
    id: string;
    release_dir: string;
  }>;
  for (const deployment of stale) {
    await removeReleaseWorktree(appId, deployment.release_dir);
    getDb().prepare("UPDATE deployments SET release_dir = NULL WHERE id = ?").run(deployment.id);
  }
}

function claimDeployment(): DeploymentRow | null {
  const db = getDb();
  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT d.* FROM deployments d
         WHERE d.state = 'queued'
           AND NOT EXISTS (
             SELECT 1 FROM deployments active
             WHERE active.app_id = d.app_id
               AND active.id != d.id
               AND active.state IN ('preparing','fetching','evaluating','starting','health-checking','activating')
           )
         ORDER BY d.queued_at ASC LIMIT 1`,
      )
      .get() as DeploymentRow | undefined;
    if (!row) return null;
    const updated = db
      .prepare(
        "UPDATE deployments SET state = 'preparing', started_at = ? WHERE id = ? AND state = 'queued'",
      )
      .run(nowIso(), row.id);
    return updated.changes ? getDeployment(row.id) : null;
  })();
}

function getDeployment(id: string): DeploymentRow {
  const row = getDb().prepare("SELECT * FROM deployments WHERE id = ?").get(id) as
    | DeploymentRow
    | undefined;
  if (!row) throw new Error(`Deployment disappeared: ${id}`);
  return row;
}

function transition(
  id: string,
  state: DeploymentState,
  extra: { internalPort?: number | null } = {},
): void {
  getDb()
    .prepare(
      "UPDATE deployments SET state = ?, internal_port = COALESCE(?, internal_port) WHERE id = ?",
    )
    .run(state, extra.internalPort ?? null, id);
}

function ensureNotCancelled(id: string): void {
  const row = getDb().prepare("SELECT cancel_requested FROM deployments WHERE id = ?").get(id) as
    | { cancel_requested: number }
    | undefined;
  if (row?.cancel_requested)
    throw new HttpError(409, "Deployment cancelled", "deployment_cancelled");
}

function preflightResources(): void {
  const metric = latestHostMetric();
  if (metric.freeDiskBytes < config.MIN_FREE_DISK_MB * 1024 * 1024) {
    throw new HttpError(
      409,
      "Deployment blocked because free disk space is below the configured reserve",
      "insufficient_disk",
    );
  }
  if (os.freemem() < config.MIN_FREE_MEMORY_MB * 1024 * 1024) {
    throw new HttpError(
      409,
      "Deployment blocked because available memory is below the configured reserve",
      "insufficient_memory",
    );
  }
}

async function waitForHealthy(
  app: AppRow,
  deploymentId: string,
  port: number,
  child: ChildProcess,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + app.startup_timeout_seconds * 1000;
  let lastError = "Application has not started listening";
  while (Date.now() < deadline) {
    if (signal.aborted) throw new HttpError(409, "Deployment cancelled", "deployment_cancelled");
    ensureNotCancelled(deploymentId);
    if (child.exitCode !== null)
      throw new Error(`Application exited before becoming healthy with code ${child.exitCode}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), app.health_timeout_seconds * 1000);
    try {
      const response = await fetch(`http://127.0.0.1:${port}${app.health_path}`, {
        signal: controller.signal,
        redirect: "manual",
      });
      if (response.status >= 200 && response.status < 400) return;
      lastError = `Health check returned HTTP ${response.status}`;
    } catch (error) {
      lastError = errorMessage(error);
    } finally {
      clearTimeout(timer);
    }
    await delay(1000);
  }
  throw new Error(
    `Application did not become healthy within ${app.startup_timeout_seconds}s: ${lastError}`,
  );
}

async function waitForStableProcess(
  deploymentId: string,
  child: ChildProcess,
  durationMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new HttpError(409, "Deployment cancelled", "deployment_cancelled");
    ensureNotCancelled(deploymentId);
    if (child.exitCode !== null)
      throw new Error(`Worker exited during startup with code ${child.exitCode}`);
    await delay(250);
  }
}

function classifyResourceFailure(
  deployment: DeploymentRow,
  error: unknown,
): { code: string; confidence: "none" | "low" | "medium" | "high" } {
  const message = errorMessage(error).toLowerCase();
  const freeMemory = os.freemem();
  if (error instanceof HttpError && error.code === "insufficient_memory")
    return { code: "insufficient_memory", confidence: "high" };
  if (error instanceof HttpError && error.code === "insufficient_disk")
    return { code: "insufficient_disk", confidence: "high" };
  if (deployment.exit_signal === "SIGKILL" && freeMemory < 128 * 1024 * 1024) {
    return { code: "probable_resource_exhaustion", confidence: "high" };
  }
  if (deployment.exit_signal === "SIGKILL") return { code: "externally_killed", confidence: "low" };
  if (message.includes("no space left") || message.includes("insufficient_disk")) {
    return { code: "insufficient_disk", confidence: "high" };
  }
  return { code: "deployment_failed", confidence: "none" };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
