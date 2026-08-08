import fs from "node:fs";
import os from "node:os";
import { config } from "./config.ts";
import { getDb, nowIso } from "./db.ts";
import { events } from "./events.ts";
import { paths } from "./paths.ts";
import { matchesProcessIdentity } from "./process-identity.ts";
import type { AppRow, DeploymentRow, RuntimeMetric } from "./types.ts";

interface CpuSample {
  ticks: number;
  at: number;
}

export class MetricsCollector {
  private timer: NodeJS.Timeout | null = null;
  private readonly previousCpu = new Map<number, CpuSample>();

  boot(): void {
    this.timer = setInterval(() => this.collect(), config.METRICS_INTERVAL_SECONDS * 1000);
    this.timer.unref();
    this.collect();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  hostMetric(): RuntimeMetric {
    const stat = fs.statfsSync(paths.data);
    return {
      timestamp: nowIso(),
      cpuPercent: hostCpuPercent(),
      memoryUsedBytes: os.totalmem() - os.freemem(),
      memoryTotalBytes: os.totalmem(),
      freeDiskBytes: stat.bavail * stat.bsize,
      loadAverage: os.loadavg(),
      uptimeSeconds: os.uptime(),
    };
  }

  private collect(): void {
    const host = this.hostMetric();
    getDb()
      .prepare(
        `INSERT INTO metrics(app_id, captured_at, cpu_percent, memory_bytes, process_count,
          free_disk_bytes, total_memory_bytes, available_memory_bytes)
         VALUES (NULL, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        host.timestamp,
        host.cpuPercent,
        host.memoryUsedBytes,
        host.freeDiskBytes,
        host.memoryTotalBytes,
        os.freemem(),
      );
    const apps = getDb()
      .prepare("SELECT * FROM applications WHERE active_deployment_id IS NOT NULL")
      .all() as AppRow[];
    for (const app of apps) {
      const deployment = getDb()
        .prepare("SELECT * FROM deployments WHERE id = ?")
        .get(app.active_deployment_id) as DeploymentRow | undefined;
      if (!deployment?.process_group_id || !matchesProcessIdentity(deployment)) continue;
      const processMetric = readProcessGroup(deployment.process_group_id, this.previousCpu);
      getDb()
        .prepare(
          `INSERT INTO metrics(app_id, captured_at, cpu_percent, memory_bytes, process_count,
            free_disk_bytes, total_memory_bytes, available_memory_bytes)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)`,
        )
        .run(
          app.id,
          host.timestamp,
          processMetric.cpuPercent,
          processMetric.memoryBytes,
          processMetric.processCount,
        );
      events.publish("metric", `app:${app.id}`, { ...processMetric, timestamp: host.timestamp });
    }
    events.publish("metric", "system", host);
    this.prune();
  }

  private prune(): void {
    const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString();
    getDb().prepare("DELETE FROM metrics WHERE captured_at < ?").run(cutoff);
  }
}

export function latestHostMetric(): RuntimeMetric {
  const stat = fs.statfsSync(paths.data);
  return {
    timestamp: nowIso(),
    cpuPercent: hostCpuPercent(),
    memoryUsedBytes: os.totalmem() - os.freemem(),
    memoryTotalBytes: os.totalmem(),
    freeDiskBytes: stat.bavail * stat.bsize,
    loadAverage: os.loadavg(),
    uptimeSeconds: os.uptime(),
  };
}

let previousHostCpu = os.cpus().map((cpu) => ({ ...cpu.times }));
function hostCpuPercent(): number {
  const current = os.cpus();
  let idleDelta = 0;
  let totalDelta = 0;
  current.forEach((cpu, index) => {
    const previous = previousHostCpu[index] ?? cpu.times;
    const total = Object.values(cpu.times).reduce<number>((sum, value) => sum + Number(value), 0);
    const previousTotal = Object.values(previous).reduce<number>(
      (sum, value) => sum + Number(value),
      0,
    );
    idleDelta += cpu.times.idle - previous.idle;
    totalDelta += total - previousTotal;
  });
  previousHostCpu = current.map((cpu) => ({ ...cpu.times }));
  return totalDelta > 0
    ? Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100))
    : 0;
}

function readProcessGroup(
  processGroupId: number,
  previous: Map<number, CpuSample>,
): { cpuPercent: number; memoryBytes: number; processCount: number } {
  if (process.platform !== "linux") return { cpuPercent: 0, memoryBytes: 0, processCount: 0 };
  const ticksPerSecond = 100;
  const pageSize = 4096;
  let ticks = 0;
  let memoryBytes = 0;
  let processCount = 0;
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      const closing = stat.lastIndexOf(")");
      const fields = stat.slice(closing + 2).split(" ");
      const pgrp = Number(fields[2]);
      if (pgrp !== processGroupId) continue;
      ticks += Number(fields[11]) + Number(fields[12]);
      memoryBytes += Number(fields[21]) * pageSize;
      processCount++;
    } catch {}
  }
  const now = Date.now();
  const last = previous.get(processGroupId);
  previous.set(processGroupId, { ticks, at: now });
  const cpuPercent =
    last && now > last.at
      ? ((ticks - last.ticks) / ticksPerSecond / ((now - last.at) / 1000)) * 100
      : 0;
  return { cpuPercent: Math.max(0, cpuPercent), memoryBytes, processCount };
}

export function latestAppMetric(
  appId: string,
): { capturedAt: string; cpuPercent: number; memoryBytes: number; processCount: number } | null {
  const row = getDb()
    .prepare(
      "SELECT captured_at, cpu_percent, memory_bytes, process_count FROM metrics WHERE app_id = ? ORDER BY captured_at DESC LIMIT 1",
    )
    .get(appId) as
    | {
        captured_at: string;
        cpu_percent: number | null;
        memory_bytes: number | null;
        process_count: number | null;
      }
    | undefined;
  return row
    ? {
        capturedAt: row.captured_at,
        cpuPercent: row.cpu_percent ?? 0,
        memoryBytes: row.memory_bytes ?? 0,
        processCount: row.process_count ?? 0,
      }
    : null;
}
