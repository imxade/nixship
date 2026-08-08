import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("database migrations", () => {
  it("apply from an empty database", () => {
    const db = temporaryDatabase();
    apply(db, migration("001_initial.sql"));
    apply(db, migration("002_process_identity.sql"));
    apply(db, migration("003_application_domains.sql"));
    apply(db, migration("004_hourly_login_limits.sql"));
    apply(db, migration("005_cloudflare_domain_status.sql"));
    apply(db, migration("006_cloudflare_oauth.sql"));
    apply(db, migration("007_quick_tunnels.sql"));
    apply(db, migration("008_active_deployments.sql"));
    apply(db, migration("009_source_integrations.sql"));

    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'application_domains'",
        )
        .get(),
    ).toEqual({ name: "application_domains" });
    expect(db.prepare("SELECT window_started_at FROM login_attempts").columns()[0]?.name).toBe(
      "window_started_at",
    );
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cloudflare_domain_status'",
        )
        .get(),
    ).toEqual({ name: "cloudflare_domain_status" });
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cloudflare_oauth_sessions'",
        )
        .get(),
    ).toEqual({ name: "cloudflare_oauth_sessions" });
    expect(db.prepare("SELECT auth_method FROM cloudflare_config").columns()[0]?.name).toBe(
      "auth_method",
    );
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'quick_tunnels'")
        .get(),
    ).toEqual({ name: "quick_tunnels" });
    expect(
      db.prepare("SELECT value FROM settings WHERE key = 'active_deployment_limit'").get(),
    ).toEqual({ value: "1" });
    expect(db.prepare("SELECT deployment_id FROM quick_tunnels").columns()[0]?.name).toBe(
      "deployment_id",
    );
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'integration_connections'",
        )
        .get(),
    ).toEqual({ name: "integration_connections" });
    expect(db.prepare("SELECT source_provider FROM applications").columns()[0]?.name).toBe(
      "source_provider",
    );
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("moves legacy application domain settings into the normalized domain table", () => {
    const db = temporaryDatabase();
    apply(db, migration("001_initial.sql"));
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO applications(
        id, name, slug, kind, repository_url, branch, flake_output,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'web', ?, 'main', 'default', ?, ?)`,
    ).run("app-1", "Example", "example", "https://github.com/example/app.git", now, now);
    db.prepare("INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)").run(
      "domain:app-1",
      "app.example.com",
      now,
    );

    apply(db, migration("002_process_identity.sql"));
    apply(db, migration("003_application_domains.sql"));
    apply(db, migration("004_hourly_login_limits.sql"));
    apply(db, migration("005_cloudflare_domain_status.sql"));
    apply(db, migration("006_cloudflare_oauth.sql"));
    apply(db, migration("007_quick_tunnels.sql"));
    apply(db, migration("008_active_deployments.sql"));
    apply(db, migration("009_source_integrations.sql"));

    expect(db.prepare("SELECT hostname, app_id FROM application_domains").all()).toEqual([
      { hostname: "app.example.com", app_id: "app-1" },
    ]);
    expect(db.prepare("SELECT 1 FROM settings WHERE key LIKE 'domain:%'").get()).toBeUndefined();
    db.close();
  });

  it("preserves legacy tunnel process identity for safe replacement", () => {
    const db = temporaryDatabase();
    for (const name of [
      "001_initial.sql",
      "002_process_identity.sql",
      "003_application_domains.sql",
      "004_hourly_login_limits.sql",
      "005_cloudflare_domain_status.sql",
      "006_cloudflare_oauth.sql",
      "007_quick_tunnels.sql",
    ]) {
      apply(db, migration(name));
    }
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO applications(
        id, name, slug, kind, repository_url, branch, flake_output, public_port,
        active_internal_port, active_deployment_id, created_at, updated_at
      ) VALUES ('app-1', 'Example', 'example', 'web', 'https://example.com/repository.git',
        'main', 'default', 10001, 20001, 'deployment-1', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO deployments(
        id, app_id, requested_ref, trigger, state, internal_port, queued_at, activated_at
      ) VALUES ('deployment-1', 'app-1', 'main', 'manual', 'running', 20001, ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO quick_tunnels(
        key, target_type, app_id, local_port, url, status, pid, process_group_id,
        process_start_ticks, process_command_hash, process_command_summary, updated_at
      ) VALUES ('app:app-1', 'application', 'app-1', 10001,
        'https://legacy.trycloudflare.com', 'running', 1234, 1234, '77', 'hash',
        'cloudflared tunnel', ?)`,
    ).run(now);

    apply(db, migration("008_active_deployments.sql"));

    expect(
      db
        .prepare(
          `SELECT key, target_type, app_id, deployment_id, local_port, pid,
            process_start_ticks, process_command_hash
           FROM quick_tunnels WHERE deployment_id = 'deployment-1'`,
        )
        .get(),
    ).toEqual({
      key: "deployment:deployment-1",
      target_type: "deployment",
      app_id: "app-1",
      deployment_id: "deployment-1",
      local_port: 10001,
      pid: 1234,
      process_start_ticks: "77",
      process_command_hash: "hash",
    });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });
});

function temporaryDatabase(): Database.Database {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "platform-migrations-"));
  temporaryDirectories.push(directory);
  const db = new Database(path.join(directory, "test.sqlite"));
  db.pragma("foreign_keys = ON");
  return db;
}

function migration(name: string): string {
  return fs.readFileSync(path.join(process.cwd(), "migrations", name), "utf8");
}

function apply(db: Database.Database, sql: string): void {
  db.transaction(() => db.exec(sql))();
}
