import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "platform-deployment-promotion-"));
process.env.PLATFORM_DATA_DIR = dataDirectory;
process.env.PLATFORM_MASTER_KEY = Buffer.alloc(32, 61).toString("base64");
process.env.QUICK_TUNNELS_ENABLED = "false";

const [{ getDb, closeDb }, { PlatformRuntime }] = await Promise.all([
  import("../../src/server/db.ts"),
  import("../../src/server/runtime.ts"),
]);

const db = getDb();

beforeEach(() => {
  db.exec(`
    DELETE FROM audit_events;
    DELETE FROM application_domains;
    DELETE FROM deployments;
    DELETE FROM applications;
  `);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO applications(
      id, name, slug, kind, repository_url, branch, flake_output, desired_state,
      active_deployment_id, active_internal_port, created_at, updated_at
    ) VALUES ('app-1', 'Example', 'example', 'web', 'https://example.com/repository.git',
      'main', 'default', 'running', 'deployment-1', 21001, ?, ?)`,
  ).run(now, now);
  const insert = db.prepare(
    `INSERT INTO deployments(
      id, app_id, requested_ref, trigger, state, internal_port, pid, queued_at, activated_at
    ) VALUES (?, 'app-1', 'main', 'manual', 'running', ?, 1234, ?, ?)`,
  );
  insert.run("deployment-1", 21001, "2026-01-01T00:00:00.000Z", now);
  insert.run("deployment-2", 21002, "2026-01-02T00:00:00.000Z", now);
});

afterAll(() => {
  closeDb();
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});

describe("deployment promotion", () => {
  it("switches the production pointer without changing deployment state", async () => {
    db.prepare(
      "INSERT INTO application_domains(hostname, app_id, created_at, updated_at) VALUES ('app.example.com', 'app-1', ?, ?)",
    ).run(new Date().toISOString(), new Date().toISOString());
    const runtime = new PlatformRuntime();
    runtime.supervisor.isAlive = () => true;

    await runtime.promoteDeployment("deployment-2");

    expect(
      db
        .prepare(
          "SELECT active_deployment_id, active_internal_port FROM applications WHERE id = 'app-1'",
        )
        .get(),
    ).toEqual({ active_deployment_id: "deployment-2", active_internal_port: 21002 });
    expect(
      db.prepare("SELECT id, state FROM deployments WHERE app_id = 'app-1' ORDER BY id").all(),
    ).toEqual([
      { id: "deployment-1", state: "running" },
      { id: "deployment-2", state: "running" },
    ]);
  });

  it("rejects promotion when no production domain is configured", async () => {
    const runtime = new PlatformRuntime();
    runtime.supervisor.isAlive = () => true;

    await expect(runtime.promoteDeployment("deployment-2")).rejects.toMatchObject({
      code: "production_domain_required",
    });
    expect(
      db.prepare("SELECT active_deployment_id FROM applications WHERE id = 'app-1'").get(),
    ).toEqual({ active_deployment_id: "deployment-1" });
  });
});
