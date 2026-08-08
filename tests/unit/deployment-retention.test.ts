import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "platform-deployment-retention-"));
process.env.PLATFORM_DATA_DIR = dataDirectory;
process.env.PLATFORM_MASTER_KEY = Buffer.alloc(32, 51).toString("base64");
process.env.QUICK_TUNNELS_ENABLED = "false";

const [database, deploymentSettings, engineModule, supervisorModule, proxyModule, tunnelModule] =
  await Promise.all([
    import("../../src/server/db.ts"),
    import("../../src/server/deployment-settings.ts"),
    import("../../src/server/deployment-engine.ts"),
    import("../../src/server/process-supervisor.ts"),
    import("../../src/server/proxy-manager.ts"),
    import("../../src/server/quick-tunnels.ts"),
  ]);

afterAll(() => {
  database.closeDb();
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});

describe("active deployment retention", () => {
  it("falls back safely when a stored value is invalid", () => {
    database.setSetting("active_deployment_limit", "0");
    expect(deploymentSettings.activeDeploymentLimit()).toBe(1);
    database.setSetting("active_deployment_limit", "999999");
    expect(deploymentSettings.activeDeploymentLimit()).toBe(1);
  });

  it("deactivates the oldest deployment independently for one project", async () => {
    const now = new Date().toISOString();
    database
      .getDb()
      .prepare(
        `INSERT INTO applications(
          id, name, slug, kind, repository_url, branch, flake_output,
          desired_state, active_deployment_id, created_at, updated_at
        ) VALUES ('app-a', 'A', 'a', 'worker', 'https://github.com/imxade/HitSea.git',
          'main', 'default', 'running', 'release-3', ?, ?)`,
      )
      .run(now, now);
    database
      .getDb()
      .prepare(
        `INSERT INTO applications(
          id, name, slug, kind, repository_url, branch, flake_output,
          desired_state, active_deployment_id, created_at, updated_at
        ) VALUES ('app-b', 'B', 'b', 'worker', 'https://github.com/imxade/HitSea.git',
          'main', 'default', 'running', 'other-release', ?, ?)`,
      )
      .run(now, now);
    const insert = database.getDb().prepare(
      `INSERT INTO deployments(
        id, app_id, requested_ref, trigger, state, queued_at, activated_at
      ) VALUES (?, 'app-a', 'main', 'manual', 'running', ?, ?)`,
    );
    insert.run("release-1", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z");
    insert.run("release-2", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:01.000Z");
    insert.run("release-3", "2026-01-03T00:00:00.000Z", "2026-01-03T00:00:01.000Z");
    database
      .getDb()
      .prepare(
        `INSERT INTO deployments(
          id, app_id, requested_ref, trigger, state, queued_at, activated_at
        ) VALUES ('other-release', 'app-b', 'main', 'manual', 'running', ?, ?)`,
      )
      .run("2025-01-01T00:00:00.000Z", "2025-01-01T00:00:01.000Z");
    deploymentSettings.updateActiveDeploymentLimit(2);

    const engine = new engineModule.DeploymentEngine(
      new supervisorModule.ProcessSupervisor(),
      new proxyModule.ProxyManager(),
      new tunnelModule.QuickTunnelController(),
    );
    await expect(engine.enforceActiveDeploymentLimit("app-a")).resolves.toEqual(["release-1"]);
    expect(
      database
        .getDb()
        .prepare("SELECT id, state FROM deployments WHERE app_id = 'app-a' ORDER BY id")
        .all(),
    ).toEqual([
      { id: "release-1", state: "superseded" },
      { id: "release-2", state: "running" },
      { id: "release-3", state: "running" },
    ]);
    expect(
      database.getDb().prepare("SELECT state FROM deployments WHERE id = 'other-release'").get(),
    ).toEqual({ state: "running" });
  });

  it("assigns a separate tunnel target only while a web deployment is active", () => {
    const now = new Date().toISOString();
    database
      .getDb()
      .prepare(
        `INSERT INTO applications(
          id, name, slug, kind, repository_url, branch, flake_output,
          desired_state, active_deployment_id, active_internal_port, created_at, updated_at
        ) VALUES ('app-web', 'Web', 'web', 'web', 'https://github.com/imxade/HitSea.git',
          'main', 'default', 'running', 'web-release', 43123, ?, ?)`,
      )
      .run(now, now);
    database
      .getDb()
      .prepare(
        `INSERT INTO deployments(
          id, app_id, requested_ref, trigger, state, internal_port, queued_at, activated_at
        ) VALUES ('web-release', 'app-web', 'main', 'manual', 'running', 43123, ?, ?)`,
      )
      .run(now, now);

    expect(tunnelModule.quickTunnelTargets().get("deployment:web-release")).toMatchObject({
      deploymentId: "web-release",
      appId: "app-web",
      localPort: 43123,
      targetType: "deployment",
    });
    database
      .getDb()
      .prepare("UPDATE deployments SET state = 'superseded' WHERE id = 'web-release'")
      .run();
    expect(tunnelModule.quickTunnelTargets().has("deployment:web-release")).toBe(false);
  });
});
