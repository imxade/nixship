import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import { isIPv4 } from "node:net";
import { spawnLogged } from "./command.ts";
import { config } from "./config.ts";
import { getDb, nowIso } from "./db.ts";
import { events } from "./events.ts";
import { logger } from "./logger.ts";
import { paths } from "./paths.ts";
import {
  captureProcessIdentity,
  matchesProcessIdentity,
  type ProcessIdentity,
} from "./process-identity.ts";
import { synchronizeGitHubWebhook } from "./public-webhook.ts";
import { parseQuickTunnelUrl } from "./quick-tunnel-url.ts";

export type QuickTunnelStatus = "starting" | "running" | "error";
export type QuickTunnelTargetType = "dashboard" | "deployment";

interface QuickTunnelRow {
  key: string;
  target_type: QuickTunnelTargetType;
  app_id: string | null;
  deployment_id: string | null;
  local_port: number;
  url: string | null;
  status: QuickTunnelStatus;
  pid: number | null;
  process_group_id: number | null;
  process_start_ticks: string | null;
  process_command_hash: string | null;
  process_command_summary: string | null;
  failure_count: number;
  next_retry_at: string | null;
  last_error: string | null;
  started_at: string | null;
  updated_at: string;
}

interface QuickTunnelStatusRow extends QuickTunnelRow {
  app_name: string | null;
  commit_sha: string | null;
}

interface ManagedQuickTunnel {
  key: string;
  child: ChildProcess;
  identity: ProcessIdentity;
  expectedStop: boolean;
}

interface QuickTunnelTarget {
  key: string;
  targetType: QuickTunnelTargetType;
  appId: string | null;
  appName: string | null;
  deploymentId: string | null;
  commitSha: string | null;
  localPort: number;
}

export interface QuickTunnelRoute {
  key: string;
  targetType: QuickTunnelTargetType;
  appId: string | null;
  appName: string | null;
  deploymentId: string | null;
  commitSha: string | null;
  localPort: number;
  url: string | null;
  status: QuickTunnelStatus;
  running: boolean;
  lastError: string | null;
  startedAt: string | null;
  updatedAt: string;
}

type RouteReadinessCheck = (url: string, targetType: QuickTunnelTargetType) => Promise<boolean>;

const STARTUP_TIMEOUT_MS = 90_000;
const PUBLIC_ROUTE_TIMEOUT_MS = 90_000;
const DNS_QUERY_TIMEOUT_MS = 10_000;
const EDGE_QUERY_TIMEOUT_MS = 25_000;
const RUNNING_ROUTE_RECHECK_MS = 60_000;
const RUNNING_ROUTE_FAILURE_LIMIT = 3;
const MAX_LOG_BYTES = 512 * 1024;
export class QuickTunnelController {
  private readonly managed = new Map<string, ManagedQuickTunnel>();
  private timer: NodeJS.Timeout | null = null;
  private reconciliation: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly routeIsReachable: RouteReadinessCheck = quickTunnelRouteIsReachable,
  ) {}

  async boot(): Promise<void> {
    if (!config.QUICK_TUNNELS_ENABLED) {
      await this.stopAllAndClear();
      return;
    }
    await this.reconcile();
    this.timer = setInterval(
      () => void this.reconcile(),
      config.QUICK_TUNNEL_RECONCILE_SECONDS * 1000,
    );
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.reconciliation) await this.reconciliation.catch(() => undefined);
    await this.stopAllAndClear();
  }

  status(): { enabled: boolean; routes: QuickTunnelRoute[] } {
    const rows = getDb()
      .prepare(
        `SELECT q.*, a.name AS app_name, d.commit_sha
         FROM quick_tunnels q
         LEFT JOIN applications a ON a.id = q.app_id
         LEFT JOIN deployments d ON d.id = q.deployment_id
         ORDER BY q.target_type, q.key`,
      )
      .all() as QuickTunnelStatusRow[];
    return {
      enabled: config.QUICK_TUNNELS_ENABLED,
      routes: rows.map((row) => {
        return {
          key: row.key,
          targetType: row.target_type,
          appId: row.app_id,
          appName: row.app_name,
          deploymentId: row.deployment_id,
          commitSha: row.commit_sha,
          localPort: row.local_port,
          url: row.url,
          status: row.status,
          running: this.isRunning(row),
          lastError: row.last_error,
          startedAt: row.started_at,
          updatedAt: row.updated_at,
        };
      }),
    };
  }

  deploymentRoute(deploymentId: string): QuickTunnelRoute | null {
    return this.status().routes.find((route) => route.deploymentId === deploymentId) ?? null;
  }

  applicationRoutes(appId: string): QuickTunnelRoute[] {
    return this.status().routes.filter((route) => route.appId === appId);
  }

  async removeApplication(appId: string): Promise<void> {
    const rows = getDb()
      .prepare("SELECT * FROM quick_tunnels WHERE app_id = ?")
      .all(appId) as QuickTunnelRow[];
    for (const row of rows) {
      await this.stopRow(row);
      getDb().prepare("DELETE FROM quick_tunnels WHERE key = ?").run(row.key);
      events.publish("quick_tunnel.removed", `app:${appId}`, { key: row.key });
    }
  }

  async reconcile(): Promise<void> {
    if (this.closed || !config.QUICK_TUNNELS_ENABLED) return;
    if (this.reconciliation) return this.reconciliation;
    this.reconciliation = this.reconcileOnce().finally(() => {
      this.reconciliation = null;
    });
    return this.reconciliation;
  }

  private async reconcileOnce(): Promise<void> {
    const expected = quickTunnelTargets();
    const existing = getDb().prepare("SELECT * FROM quick_tunnels").all() as QuickTunnelRow[];

    for (const row of existing) {
      const target = expected.get(row.key);
      if (!target) {
        await this.stopRow(row);
        getDb().prepare("DELETE FROM quick_tunnels WHERE key = ?").run(row.key);
        continue;
      }
      if (row.local_port !== target.localPort) {
        await this.stopRow(row);
        getDb().prepare("DELETE FROM quick_tunnels WHERE key = ?").run(row.key);
      }
    }

    await Promise.all([...expected.values()].map((target) => this.reconcileTarget(target)));
  }

  private async reconcileTarget(target: QuickTunnelTarget): Promise<void> {
    let row = getQuickTunnel(target.key);
    if (!row) {
      const now = nowIso();
      getDb()
        .prepare(
          `INSERT INTO quick_tunnels(
            key, target_type, app_id, deployment_id, local_port, status, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'starting', ?)`,
        )
        .run(
          target.key,
          target.targetType,
          target.appId,
          target.deploymentId,
          target.localPort,
          now,
        );
      row = getQuickTunnel(target.key);
    }
    if (!row) return;

    const alive = this.isRunning(row);
    if (alive) {
      const discoveredUrl = row.url ?? readQuickTunnelUrl(logPath(target.key));
      const requiresPublication =
        Boolean(discoveredUrl) && (row.url !== discoveredUrl || row.status !== "running");
      const requiresRecheck =
        Boolean(discoveredUrl) &&
        row.status === "running" &&
        row.url === discoveredUrl &&
        Date.parse(row.updated_at) + RUNNING_ROUTE_RECHECK_MS <= Date.now();
      if (discoveredUrl && (requiresPublication || requiresRecheck)) {
        if (await this.routeIsReachable(discoveredUrl, target.targetType)) {
          const result = getDb()
            .prepare(
              `UPDATE quick_tunnels SET url = ?, status = 'running', failure_count = 0,
               next_retry_at = NULL, last_error = NULL, updated_at = ? WHERE key = ?`,
            )
            .run(discoveredUrl, nowIso(), target.key);
          if (result.changes === 0) return;
          if (requiresPublication && target.targetType === "dashboard") {
            void synchronizeGitHubWebhook().catch(() => undefined);
          }
          if (requiresPublication) {
            events.publish("quick_tunnel.ready", target.appId ? `app:${target.appId}` : "system", {
              key: target.key,
              url: discoveredUrl,
              localPort: target.localPort,
            });
          }
        } else if (requiresRecheck) {
          const failures = row.failure_count + 1;
          if (failures < RUNNING_ROUTE_FAILURE_LIMIT) {
            getDb()
              .prepare(
                `UPDATE quick_tunnels SET failure_count = ?, last_error = ?,
                 updated_at = ? WHERE key = ?`,
              )
              .run(
                failures,
                "Cloudflare Quick Tunnel public-edge check failed; retrying",
                nowIso(),
                target.key,
              );
          } else {
            await this.stopRow(row);
            this.recordFailure(
              target.key,
              "Cloudflare Quick Tunnel repeatedly stopped serving its public route",
              failures,
            );
          }
        } else if (
          row.started_at &&
          Date.parse(row.started_at) + PUBLIC_ROUTE_TIMEOUT_MS < Date.now()
        ) {
          await this.stopRow(row);
          this.recordFailure(
            target.key,
            "Cloudflare did not make the Quick Tunnel route reachable in time",
          );
        }
      } else if (
        !discoveredUrl &&
        row.started_at &&
        Date.parse(row.started_at) + STARTUP_TIMEOUT_MS < Date.now()
      ) {
        await this.stopRow(row);
        this.recordFailure(target.key, "cloudflared did not publish a Quick Tunnel URL in time");
      }
      return;
    }

    if (row.pid || row.process_group_id) {
      this.managed.delete(row.key);
      this.recordFailure(
        row.key,
        row.last_error ?? "The Quick Tunnel process stopped unexpectedly",
      );
      row = getQuickTunnel(target.key);
      if (!row) return;
    }

    if (row.next_retry_at && Date.parse(row.next_retry_at) > Date.now()) return;
    await this.startTarget(target, row.failure_count);
  }

  private async startTarget(target: QuickTunnelTarget, previousFailures: number): Promise<void> {
    const log = logPath(target.key);
    fs.writeFileSync(log, "", { mode: 0o600 });
    const now = nowIso();
    getDb()
      .prepare(
        `UPDATE quick_tunnels SET url = NULL, status = 'starting', pid = NULL,
         process_group_id = NULL, process_start_ticks = NULL, process_command_hash = NULL,
         process_command_summary = NULL, last_error = NULL, started_at = ?, updated_at = ?
         WHERE key = ?`,
      )
      .run(now, now, target.key);

    let child: ChildProcess;
    try {
      child = spawnLogged(config.CLOUDFLARED_BIN, quickTunnelArguments(target.localPort), {
        cwd: paths.data,
        env: process.env,
        stdoutPath: log,
        stderrPath: log,
        detached: true,
      });
    } catch (error) {
      this.recordFailure(target.key, errorMessage(error), previousFailures + 1);
      return;
    }

    let pid: number;
    try {
      pid = await spawnedProcessId(child);
    } catch (error) {
      this.recordFailure(target.key, cloudflaredStartError(error), previousFailures + 1);
      return;
    }

    let terminalHandled = false;
    child.once("error", (error) => {
      if (terminalHandled) return;
      terminalHandled = true;
      this.managed.delete(target.key);
      this.recordFailure(target.key, cloudflaredStartError(error), previousFailures + 1);
    });

    const identity = captureProcessIdentity(pid);
    if (!identity) {
      terminalHandled = true;
      terminateIdentity(
        {
          pid,
          processGroupId: pid,
          startTicks: null,
          commandHash: null,
          commandSummary: null,
        },
        "SIGKILL",
      );
      this.recordFailure(
        target.key,
        "Unable to establish a safe identity for the Quick Tunnel process",
        previousFailures + 1,
      );
      return;
    }

    const managed: ManagedQuickTunnel = {
      key: target.key,
      child,
      identity,
      expectedStop: false,
    };
    this.managed.set(target.key, managed);
    getDb()
      .prepare(
        `UPDATE quick_tunnels SET pid = ?, process_group_id = ?, process_start_ticks = ?,
         process_command_hash = ?, process_command_summary = ?, status = 'starting',
         updated_at = ? WHERE key = ?`,
      )
      .run(
        identity.pid,
        identity.processGroupId,
        identity.startTicks,
        identity.commandHash,
        identity.commandSummary,
        nowIso(),
        target.key,
      );
    child.unref();
    child.once("exit", (code, signal) => {
      if (terminalHandled) return;
      terminalHandled = true;
      this.managed.delete(target.key);
      if (managed.expectedStop) return;
      this.recordFailure(
        target.key,
        `cloudflared exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`,
      );
      events.publish("quick_tunnel.stopped", target.appId ? `app:${target.appId}` : "system", {
        key: target.key,
        code,
        signal,
      });
    });
  }

  private recordFailure(key: string, message: string, failureCount?: number): void {
    const current = getQuickTunnel(key);
    if (!current) return;
    const failures = failureCount ?? current.failure_count + 1;
    const delaySeconds = Math.min(300, 10 * 2 ** Math.min(failures - 1, 5));
    const retryAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
    getDb()
      .prepare(
        `UPDATE quick_tunnels SET url = NULL, status = 'error', pid = NULL,
         process_group_id = NULL, process_start_ticks = NULL, process_command_hash = NULL,
         process_command_summary = NULL, failure_count = ?, next_retry_at = ?, last_error = ?,
         updated_at = ? WHERE key = ?`,
      )
      .run(failures, retryAt, message.slice(0, 1000), nowIso(), key);
    if (key === "dashboard") void synchronizeGitHubWebhook().catch(() => undefined);
    logger.warn("Quick Tunnel unavailable", { key, error: message, retryAt });
  }

  private async stopRow(row: QuickTunnelRow): Promise<void> {
    const managed = this.managed.get(row.key);
    if (managed) managed.expectedStop = true;
    const identity = managed?.identity ?? rowIdentity(row);
    if (identity && this.isRunning(row)) {
      terminateIdentity(identity, "SIGTERM");
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && this.isRunning(row)) await delay(100);
      if (this.isRunning(row)) terminateIdentity(identity, "SIGKILL");
    }
    this.managed.delete(row.key);
  }

  private isRunning(row: QuickTunnelRow): boolean {
    const managed = this.managed.get(row.key);
    if (
      managed?.child.pid === row.pid &&
      managed.child.exitCode === null &&
      managed.identity.startTicks === row.process_start_ticks
    ) {
      return true;
    }
    return matchesProcessIdentity({
      pid: row.pid,
      process_group_id: row.process_group_id,
      process_start_ticks: row.process_start_ticks,
      process_command_hash: row.process_command_hash,
      process_command_summary: row.process_command_summary,
    });
  }

  private async stopAllAndClear(): Promise<void> {
    const rows = getDb().prepare("SELECT * FROM quick_tunnels").all() as QuickTunnelRow[];
    for (const row of rows) await this.stopRow(row);
    getDb().prepare("DELETE FROM quick_tunnels").run();
  }
}

export function quickTunnelTargets(): Map<string, QuickTunnelTarget> {
  const targets = new Map<string, QuickTunnelTarget>();
  targets.set("dashboard", {
    key: "dashboard",
    targetType: "dashboard",
    appId: null,
    appName: null,
    deploymentId: null,
    commitSha: null,
    localPort: config.PORT,
  });
  const deployments = getDb()
    .prepare(
      `SELECT d.id, d.app_id, d.commit_sha, d.internal_port, a.name AS app_name
       FROM deployments d
       JOIN applications a ON a.id = d.app_id
       WHERE d.state = 'running' AND d.internal_port IS NOT NULL
         AND a.kind = 'web' AND a.desired_state = 'running'
       ORDER BY d.activated_at, d.queued_at, d.id`,
    )
    .all() as Array<{
    id: string;
    app_id: string;
    commit_sha: string | null;
    internal_port: number;
    app_name: string;
  }>;
  for (const deployment of deployments) {
    targets.set(`deployment:${deployment.id}`, {
      key: `deployment:${deployment.id}`,
      targetType: "deployment",
      appId: deployment.app_id,
      appName: deployment.app_name,
      deploymentId: deployment.id,
      commitSha: deployment.commit_sha,
      localPort: deployment.internal_port,
    });
  }
  return targets;
}

function getQuickTunnel(key: string): QuickTunnelRow | null {
  return (
    (getDb().prepare("SELECT * FROM quick_tunnels WHERE key = ?").get(key) as
      | QuickTunnelRow
      | undefined) ?? null
  );
}

function readQuickTunnelUrl(file: string): string | null {
  let fd: number | null = null;
  try {
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const start = Math.max(0, stat.size - MAX_LOG_BYTES);
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return parseQuickTunnelUrl(buffer.toString("utf8"));
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function logPath(key: string): string {
  return `${paths.logs}/quick-tunnel-${safeKey(key)}.log`;
}

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function rowIdentity(row: QuickTunnelRow): ProcessIdentity | null {
  if (!row.pid || !row.process_group_id) return null;
  return {
    pid: row.pid,
    processGroupId: row.process_group_id,
    startTicks: row.process_start_ticks,
    commandHash: row.process_command_hash,
    commandSummary: row.process_command_summary,
  };
}

function terminateIdentity(identity: ProcessIdentity, signal: NodeJS.Signals): void {
  try {
    process.kill(process.platform === "win32" ? identity.pid : -identity.processGroupId, signal);
  } catch {
    // The process may already have exited.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function spawnedProcessId(child: ChildProcess): Promise<number> {
  if (child.pid) return child.pid;
  await new Promise<void>((resolve, reject) => {
    const onSpawn = (): void => {
      child.off("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
  if (!child.pid) throw new Error("cloudflared started without a process ID");
  return child.pid;
}

export function cloudflaredStartError(error: unknown): string {
  const message = errorMessage(error);
  if (
    message.includes("ENOENT") ||
    (error instanceof Error && "code" in error && error.code === "ENOENT")
  ) {
    return "Missing dependency: cloudflared. Install cloudflared or set CLOUDFLARED_BIN to its absolute path.";
  }
  return `Unable to start cloudflared: ${message}`;
}

export function quickTunnelArguments(localPort: number): string[] {
  return [
    "tunnel",
    "--config",
    "/dev/null",
    "--no-autoupdate",
    "--loglevel",
    "info",
    "--output",
    "json",
    "--protocol",
    "http2",
    "--edge-ip-version",
    "4",
    "--url",
    `http://127.0.0.1:${localPort}`,
  ];
}

export async function quickTunnelHostnameIsPublished(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const normalized = parseQuickTunnelUrl(url);
  if (!normalized) return false;
  const hostname = new URL(normalized).hostname;
  try {
    const response = await fetcher(
      `https://cloudflare-dns.com/dns-query?${new URLSearchParams({
        name: hostname,
        type: "A",
      })}`,
      {
        cache: "no-store",
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(DNS_QUERY_TIMEOUT_MS),
      },
    );
    if (!response.ok) return false;
    return hasPublishedIpv4Answer(await response.json());
  } catch {
    return false;
  }
}

export async function quickTunnelRouteIsReachable(
  url: string,
  targetType: QuickTunnelTargetType,
  fetcher: typeof fetch = fetch,
  hostnameIsPublished: (candidate: string) => Promise<boolean> = (candidate) =>
    quickTunnelHostnameIsPublished(candidate, fetcher),
): Promise<boolean> {
  const normalized = parseQuickTunnelUrl(url);
  if (!normalized || !(await hostnameIsPublished(normalized))) return false;
  const endpoint = new URL(targetType === "dashboard" ? "/api/health" : "/", normalized);
  try {
    const response = await fetcher(endpoint, {
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(EDGE_QUERY_TIMEOUT_MS),
    });
    if (targetType === "dashboard") return response.status === 200;
    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  }
}

function hasPublishedIpv4Answer(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as { Status?: unknown; Answer?: unknown };
  if (candidate.Status !== 0 || !Array.isArray(candidate.Answer)) return false;
  return candidate.Answer.some(
    (answer) =>
      Boolean(answer) &&
      typeof answer === "object" &&
      (answer as { type?: unknown }).type === 1 &&
      typeof (answer as { data?: unknown }).data === "string" &&
      isIPv4((answer as { data: string }).data),
  );
}
