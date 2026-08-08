import { queueDeployment } from "./app-service.ts";
import { config } from "./config.ts";
import { getDb, nowIso } from "./db.ts";
import { events } from "./events.ts";
import { pollHarburEvents } from "./harbur.ts";
import { logger } from "./logger.ts";
import type { AppRow, IntegrationConnectionRow } from "./types.ts";

export class HarburReconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  boot(): void {
    this.timer = setInterval(() => void this.reconcile(), config.SOURCE_POLL_SECONDS * 1000);
    this.timer.unref();
    setTimeout(() => void this.reconcile(), 7000).unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async reconcile(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const connections = getDb()
        .prepare(
          "SELECT * FROM integration_connections WHERE provider = 'harbur' AND token_encrypted IS NOT NULL ORDER BY id",
        )
        .all() as IntegrationConnectionRow[];
      for (const connection of connections) await this.reconcileConnection(connection);
    } finally {
      this.running = false;
    }
  }

  private async reconcileConnection(initial: IntegrationConnectionRow) {
    let connection = initial;
    try {
      for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
        const page = await pollHarburEvents(connection);
        for (const event of page.events) {
          const apps = getDb()
            .prepare(
              `SELECT * FROM applications
               WHERE source_provider = 'harbur' AND source_connection_id = ?
                 AND source_repository_id = ? AND auto_deploy = 1 AND desired_state = 'running'
               ORDER BY id`,
            )
            .all(connection.id, event.repositoryId) as AppRow[];
          for (const app of apps) {
            const alreadyObserved = Boolean(
              getDb()
                .prepare("SELECT 1 FROM deployments WHERE app_id = ? AND commit_sha = ? LIMIT 1")
                .get(app.id, event.revision),
            );
            if (!shouldQueueHarburRevision(alreadyObserved)) continue;
            const deployment = queueDeployment(app.id, {
              commitSha: event.revision,
              requestedRef: event.revision,
              trigger: "reconcile",
            });
            events.publish("deployment.queued", `app:${app.id}`, {
              deploymentId: deployment.id,
              revision: event.revision,
              trigger: "harbur_snapshot",
            });
          }
        }
        if (page.nextCursor < connection.event_cursor) {
          throw new Error("Harbur event cursor moved backwards");
        }
        getDb()
          .prepare(
            `UPDATE integration_connections
             SET event_cursor = ?, status = 'connected', last_error = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(page.nextCursor, nowIso(), connection.id);
        connection = { ...connection, event_cursor: page.nextCursor };
        if (!page.hasMore) return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 2000) : String(error);
      getDb()
        .prepare(
          `UPDATE integration_connections SET status = 'error', last_error = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(message, nowIso(), connection.id);
      logger.warn("Harbur reconciliation failed", { connectionId: connection.id, error: message });
    }
  }
}

export function shouldQueueHarburRevision(alreadyObserved: boolean) {
  return !alreadyObserved;
}
