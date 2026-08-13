import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "platform-app-environment-test-"));
process.env.PLATFORM_DATA_DIR = dataDirectory;
process.env.PLATFORM_MASTER_KEY = Buffer.alloc(32, 97).toString("base64");

const [database, appService, environment] = await Promise.all([
  import("../../src/server/db.ts"),
  import("../../src/server/app-service.ts"),
  import("../../src/server/environment.ts"),
]);

const db = database.getDb();

beforeEach(() => {
  db.prepare("DELETE FROM audit_events").run();
  db.prepare("DELETE FROM app_environment").run();
  db.prepare("DELETE FROM applications").run();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO applications(
      id, name, slug, kind, repository_url, branch, flake_output, created_at, updated_at
    ) VALUES ('app-1', 'App', 'app', 'worker', 'https://github.com/example/app.git',
      'main', 'default', ?, ?)`,
  ).run(now, now);
});

afterAll(() => {
  database.closeDb();
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});

describe("application environment boundary", () => {
  it("rejects every runtime-owned name without storing a value", () => {
    for (const key of environment.APPLICATION_RUNTIME_ENVIRONMENT_KEYS) {
      expect(() => appService.setEnvironment("app-1", { [key]: "override" })).toThrowError(
        expect.objectContaining({ status: 400, code: "reserved_env_key" }),
      );
    }
    expect(() =>
      appService.setEnvironment("app-1", { platform_master_key: "override" }),
    ).toThrowError(expect.objectContaining({ status: 400, code: "reserved_env_key" }));
    expect(db.prepare("SELECT COUNT(*) AS count FROM app_environment").get()).toEqual({ count: 0 });
  });

  it("allows deliberate application HOME and PATH values", () => {
    appService.setEnvironment("app-1", { HOME: "/app/home", PATH: "/app/bin" });
    expect(appService.environmentKeys("app-1")).toEqual([
      expect.objectContaining({ key: "HOME", secret: true }),
      expect.objectContaining({ key: "PATH", secret: true }),
    ]);
  });
});
