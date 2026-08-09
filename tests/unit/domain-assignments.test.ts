import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "platform-domains-test-"));
process.env.PLATFORM_DATA_DIR = dataDirectory;
process.env.PLATFORM_MASTER_KEY = Buffer.alloc(32, 41).toString("base64");

const [database, appService, assignments] = await Promise.all([
  import("../../src/server/db.ts"),
  import("../../src/server/app-service.ts"),
  import("../../src/server/domain-assignments.ts"),
]);

const db = database.getDb();
const now = "2026-08-09T00:00:00.000Z";

beforeEach(() => {
  db.prepare("DELETE FROM quick_tunnels").run();
  db.prepare("DELETE FROM domain_assignments").run();
  db.prepare("DELETE FROM application_domains").run();
  db.prepare("DELETE FROM applications").run();
  const insert = db.prepare(
    `INSERT INTO applications(
      id, name, slug, kind, repository_url, branch, flake_output, public_port,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'web', ?, 'main', 'default', ?, ?, ?)`,
  );
  insert.run(
    "app-1",
    "Apex App",
    "apex-app",
    "https://github.com/example/apex.git",
    10041,
    now,
    now,
  );
  insert.run(
    "app-2",
    "Subdomain App",
    "subdomain-app",
    "https://github.com/example/subdomain.git",
    10042,
    now,
    now,
  );
});

afterAll(() => {
  database.closeDb();
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});

describe("domain assignments", () => {
  it("allows independent apex and subdomain assignments", () => {
    appService.replaceApplicationDomains("app-1", ["example.com"]);
    appService.replaceApplicationDomains("app-2", ["test.example.com"]);

    expect(
      db.prepare("SELECT hostname, app_id FROM domain_assignments ORDER BY hostname").all(),
    ).toEqual([
      { hostname: "example.com", app_id: "app-1" },
      { hostname: "test.example.com", app_id: "app-2" },
    ]);
  });

  it("rejects the same hostname for another application, including case variants", () => {
    appService.replaceApplicationDomains("app-1", ["Test.Example.com"]);

    expect(() => appService.replaceApplicationDomains("app-2", ["test.example.com"])).toThrowError(
      expect.objectContaining({ status: 409, code: "domain_already_assigned" }),
    );
    expect(appService.applicationDomains("app-1")).toEqual(["test.example.com"]);
    expect(appService.applicationDomains("app-2")).toEqual([]);
  });

  it("prevents dashboard and application assignments from colliding in either direction", () => {
    assignments.replaceDashboardDomainAssignment(null, "console.example.com");
    expect(() =>
      appService.replaceApplicationDomains("app-1", ["console.example.com"]),
    ).toThrowError(expect.objectContaining({ status: 409, code: "domain_already_assigned" }));

    assignments.replaceDashboardDomainAssignment("console.example.com", null);
    appService.replaceApplicationDomains("app-1", ["app.example.com"]);
    expect(() =>
      assignments.replaceDashboardDomainAssignment(null, "app.example.com"),
    ).toThrowError(expect.objectContaining({ status: 409, code: "domain_already_assigned" }));
  });

  it("does not alter Quick Tunnel state", () => {
    db.prepare(
      `INSERT INTO quick_tunnels(
        key, target_type, app_id, local_port, url, status, updated_at
      ) VALUES ('dashboard', 'dashboard', NULL, 3000,
        'https://example.trycloudflare.com', 'running', ?)`,
    ).run(now);
    const before = db.prepare("SELECT * FROM quick_tunnels").all();

    appService.replaceApplicationDomains("app-1", ["example.com"]);
    assignments.replaceDashboardDomainAssignment(null, "console.example.com");

    expect(db.prepare("SELECT * FROM quick_tunnels").all()).toEqual(before);
  });

  it("keeps managed removed domains until Cloudflare cleanup can prove deletion", () => {
    appService.replaceApplicationDomains("app-1", ["app.example.com", "pending.example.com"]);
    db.prepare(
      `UPDATE domain_assignments
       SET state = 'active', dns_record_id = 'dns-record', tunnel_id = 'tunnel-id'
       WHERE hostname = 'app.example.com'`,
    ).run();

    appService.replaceApplicationDomains("app-1", []);

    expect(
      db.prepare("SELECT hostname, state FROM domain_assignments ORDER BY hostname").all(),
    ).toEqual([{ hostname: "app.example.com", state: "removing" }]);
    expect(appService.applicationDomains("app-1")).toEqual([]);
  });

  it("recognizes instance-owned DNS comments after an assignment row is gone", () => {
    appService.replaceApplicationDomains("app-1", ["old.example.com"]);
    const comment = assignments.domainOwnershipComment("old.example.com");

    appService.replaceApplicationDomains("app-1", []);

    expect(assignments.ownsDomainComment(comment, "old.example.com")).toBe(true);
  });
});
