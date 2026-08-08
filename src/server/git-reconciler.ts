import { queueDeployment } from "./app-service.ts";
import { runCommand } from "./command.ts";
import { config } from "./config.ts";
import { getDb } from "./db.ts";
import { events } from "./events.ts";
import { isValidGitBranchName } from "./git.ts";
import { gitAuthenticationEnvironment, repositoryHead } from "./github.ts";
import { logger } from "./logger.ts";
import type { AppRow, DeploymentRow } from "./types.ts";

export class GitReconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  boot(): void {
    this.timer = setInterval(() => void this.reconcile(), config.SOURCE_POLL_SECONDS * 1000);
    this.timer.unref();
    setTimeout(() => void this.reconcile(), 5000).unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async reconcile(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const apps = getDb()
        .prepare(
          "SELECT * FROM applications WHERE source_provider = 'github' AND auto_deploy = 1 AND desired_state = 'running'",
        )
        .all() as AppRow[];
      for (const app of apps) {
        try {
          const head = await remoteHead(app);
          const active = app.active_deployment_id
            ? (getDb()
                .prepare("SELECT * FROM deployments WHERE id = ?")
                .get(app.active_deployment_id) as DeploymentRow | undefined)
            : undefined;
          const observed = getDb()
            .prepare("SELECT 1 FROM deployments WHERE app_id = ? AND commit_sha = ? LIMIT 1")
            .get(app.id, head);
          if (shouldQueueReconciledHead(head, active?.commit_sha ?? null, Boolean(observed))) {
            const deployment = queueDeployment(app.id, {
              commitSha: head,
              requestedRef: head,
              trigger: "reconcile",
            });
            events.publish("deployment.queued", `app:${app.id}`, {
              deploymentId: deployment.id,
              commit: head,
              trigger: "reconcile",
            });
          }
        } catch (error) {
          logger.warn("Git reconciliation failed", {
            appId: app.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}

export function shouldQueueReconciledHead(
  head: string,
  activeCommit: string | null,
  alreadyObserved: boolean,
): boolean {
  return activeCommit !== head && !alreadyObserved;
}

async function remoteHead(app: AppRow): Promise<string> {
  if (!isValidGitBranchName(app.branch)) {
    throw new Error("The configured Git branch is invalid");
  }
  if (app.github_installation_id)
    return repositoryHead(app.repository_url, app.github_installation_id, app.branch);
  const result = await runCommand(
    "git",
    ["ls-remote", app.repository_url, `refs/heads/${app.branch}`],
    {
      env: gitAuthenticationEnvironment(),
      timeoutMs: 60_000,
    },
  );
  if (result.code !== 0) throw new Error(result.stderr || "git ls-remote failed");
  const sha = result.stdout.trim().split(/\s+/)[0];
  if (!sha) throw new Error(`Branch '${app.branch}' was not found`);
  return sha;
}
