import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";
import { getDb } from "./db.ts";
import { logger } from "./logger.ts";
import { paths } from "./paths.ts";

interface LogFile {
  file: string;
  size: number;
  mtimeMs: number;
  deploymentId: string | null;
  active: boolean;
}

export interface LogPruneResult {
  removed: number;
  truncated: number;
  totalBytes: number;
}

export class LogRetentionController {
  private timer: NodeJS.Timeout | null = null;

  boot(): void {
    this.timer = setInterval(() => this.prune(), 60 * 60_000);
    this.timer.unref();
    setTimeout(() => this.prune(), 30_000).unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  prune(): void {
    try {
      const running = new Set(
        (
          getDb().prepare("SELECT id FROM deployments WHERE state = 'running'").all() as Array<{
            id: string;
          }>
        ).map((row) => row.id),
      );
      const result = pruneLogs(paths.logs, running, {
        maxAgeMs: config.LOG_RETENTION_DAYS * 86_400_000,
        maxBytes: config.LOG_MAX_MB * 1024 * 1024,
      });
      if (result.removed || result.truncated) {
        logger.info("Pruned retained logs", { ...result });
      }
    } catch (error) {
      logger.warn("Log retention failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function pruneLogs(
  root: string,
  running: ReadonlySet<string>,
  limits: { maxAgeMs: number; maxBytes: number },
  now = Date.now(),
): LogPruneResult {
  const files = walk(root, running);
  const cutoff = now - limits.maxAgeMs;
  let removed = 0;
  let truncated = 0;

  for (const item of files) {
    if (!item.active && item.mtimeMs < cutoff && item.size > 0) {
      fs.rmSync(item.file, { force: true });
      item.size = 0;
      removed++;
    }
  }

  let totalBytes = files.reduce((sum, item) => sum + item.size, 0);
  const inactive = files
    .filter((item) => !item.active && item.size > 0)
    .sort((left, right) => left.mtimeMs - right.mtimeMs);
  for (const item of inactive) {
    if (totalBytes <= limits.maxBytes) break;
    fs.rmSync(item.file, { force: true });
    totalBytes -= item.size;
    item.size = 0;
    removed++;
  }

  // Active children hold append-only descriptors. Truncating the same inode
  // bounds disk use without disconnecting their stdout/stderr streams.
  const active = files
    .filter((item) => item.active && item.size > 0)
    .sort((left, right) => right.size - left.size);
  for (const item of active) {
    if (totalBytes <= limits.maxBytes) break;
    fs.truncateSync(item.file, 0);
    totalBytes -= item.size;
    item.size = 0;
    truncated++;
  }

  return { removed, truncated, totalBytes };
}

function walk(root: string, running: ReadonlySet<string>): LogFile[] {
  if (!fs.existsSync(root)) return [];
  const output: LogFile[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      output.push(...walk(target, running));
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = fs.statSync(target);
    const match = entry.name.match(/^([0-9a-f-]{36})\./i);
    const deploymentId = match?.[1] ?? null;
    output.push({
      file: target,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      deploymentId,
      active: Boolean(
        deploymentId && running.has(deploymentId) && /\.(?:stdout|stderr)\.log$/i.test(entry.name),
      ),
    });
  }
  return output;
}
