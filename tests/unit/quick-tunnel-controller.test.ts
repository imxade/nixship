import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "platform-quick-tunnel-state-"));
process.env.HOSTNAME = "127.0.0.1";
process.env.PORT = "34567";
process.env.PLATFORM_DATA_DIR = dataDirectory;
process.env.PLATFORM_MASTER_KEY = Buffer.alloc(32, 41).toString("base64");
process.env.QUICK_TUNNELS_ENABLED = "true";

const [database, pathsModule, identityModule, quickTunnels] = await Promise.all([
  import("../../src/server/db.ts"),
  import("../../src/server/paths.ts"),
  import("../../src/server/process-identity.ts"),
  import("../../src/server/quick-tunnels.ts"),
]);

afterAll(() => {
  database.closeDb();
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});

describe("Quick Tunnel publication state", () => {
  it.skipIf(process.platform !== "linux")(
    "remains starting until the assigned public route is reachable",
    async () => {
      pathsModule.ensureDataDirectories();
      const tunnelProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
        detached: true,
        stdio: "ignore",
      });
      await new Promise<void>((resolve, reject) => {
        tunnelProcess.once("spawn", resolve);
        tunnelProcess.once("error", reject);
      });
      const identity = identityModule.captureProcessIdentity(tunnelProcess.pid ?? 0);
      expect(identity).not.toBeNull();
      const now = new Date().toISOString();
      database
        .getDb()
        .prepare(
          `INSERT INTO quick_tunnels(
          key, target_type, app_id, local_port, url, status, pid, process_group_id,
          process_start_ticks, process_command_hash, process_command_summary,
          failure_count, started_at, updated_at
        ) VALUES ('dashboard', 'dashboard', NULL, 34567, NULL, 'starting', ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          identity?.pid,
          identity?.processGroupId,
          identity?.startTicks,
          identity?.commandHash,
          identity?.commandSummary,
          now,
          now,
        );
      fs.writeFileSync(
        path.join(pathsModule.paths.logs, "quick-tunnel-dashboard.log"),
        '{"message":"https://publication-check.trycloudflare.com"}\n',
        { mode: 0o600 },
      );

      const routeIsReachable = vi.fn(async () => false);
      const controller = new quickTunnels.QuickTunnelController(routeIsReachable);
      try {
        await controller.reconcile();
        expect(readRoute()).toMatchObject({ status: "starting", url: null });

        routeIsReachable.mockResolvedValue(true);
        await controller.reconcile();
        expect(readRoute()).toMatchObject({
          status: "running",
          url: "https://publication-check.trycloudflare.com",
        });

        routeIsReachable.mockResolvedValue(false);
        for (let failure = 1; failure <= 2; failure++) {
          makeRouteRecheckDue();
          await controller.reconcile();
          expect(readRoute()).toMatchObject({
            status: "running",
            url: "https://publication-check.trycloudflare.com",
            failure_count: failure,
          });
        }

        makeRouteRecheckDue();
        await controller.reconcile();
        expect(readRoute()).toMatchObject({
          status: "error",
          url: null,
          failure_count: 3,
        });
      } finally {
        await controller.close();
        if (tunnelProcess.exitCode === null && tunnelProcess.signalCode === null) {
          tunnelProcess.kill("SIGKILL");
        }
      }
    },
  );
});

function readRoute(): { status: string; url: string | null; failure_count: number } {
  return database
    .getDb()
    .prepare("SELECT status, url, failure_count FROM quick_tunnels WHERE key = 'dashboard'")
    .get() as { status: string; url: string | null; failure_count: number };
}

function makeRouteRecheckDue(): void {
  database
    .getDb()
    .prepare("UPDATE quick_tunnels SET updated_at = ? WHERE key = 'dashboard'")
    .run(new Date(0).toISOString());
}
