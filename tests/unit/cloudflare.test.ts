import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "platform-cloudflare-test-"));
process.env.PLATFORM_DATA_DIR = dataDirectory;
process.env.PLATFORM_MASTER_KEY = Buffer.alloc(32, 29).toString("base64");

const [{ CloudflareController }, database, secrets] = await Promise.all([
  import("../../src/server/cloudflare.ts"),
  import("../../src/server/db.ts"),
  import("../../src/server/crypto.ts"),
]);

const apiCalls: Array<{ url: string; init?: RequestInit }> = [];
let failNextConfiguration = false;
const cloudflareFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  apiCalls.push({ url, init });
  const parsed = new URL(url);
  if (parsed.hostname === "cloudflare-dns.com") {
    const apex = parsed.searchParams.get("name");
    const nameservers =
      apex === "example.com"
        ? ["alice.ns.cloudflare.com.", "bob.ns.cloudflare.com."]
        : ["ns1.external.test.", "ns2.external.test."];
    return new Response(
      JSON.stringify({
        Status: 0,
        Answer: nameservers.map((data) => ({ type: 2, data })),
      }),
      { status: 200, headers: { "content-type": "application/dns-json" } },
    );
  }
  if (parsed.pathname.endsWith("/configurations") && failNextConfiguration) {
    failNextConfiguration = false;
    return new Response(
      JSON.stringify({ success: false, errors: [{ message: "configuration rejected" }] }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
  if (parsed.pathname.startsWith("/client/v4/accounts/other-account/")) {
    return new Response(
      JSON.stringify({ success: false, errors: [{ message: "account access denied" }] }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }
  let result: unknown = {};
  if (parsed.pathname === "/client/v4/user/tokens/verify") {
    result = { id: "token-id", status: "active" };
  } else if (parsed.pathname === "/client/v4/accounts/account/cfd_tunnel" && parsed.search) {
    result = [];
  } else if (parsed.pathname.endsWith("/dns_records") && parsed.search) {
    const hostname = parsed.searchParams.get("name");
    if (hostname === "foreign.example.com") {
      result = [
        {
          id: "foreign-record",
          type: "CNAME",
          content: "tunnel-id.cfargotunnel.com",
          comment: null,
        },
      ];
    } else if (hostname === "changed.example.com") {
      result = [
        {
          id: "changed-record",
          type: "CNAME",
          content: "other.example.net",
          comment: "Managed by Nix Ship",
        },
      ];
    } else if (hostname === "occupied.example.com") {
      result = [
        {
          id: "occupied-record",
          type: "CNAME",
          content: "cname.vercel-dns.com",
          comment: null,
        },
      ];
    } else if (hostname?.endsWith(".example.com")) {
      result = [
        {
          id: "dns-record",
          type: "CNAME",
          content: "tunnel-id.cfargotunnel.com",
          comment: "Managed by Nix Ship",
        },
      ];
    } else {
      result = [];
    }
  } else if (parsed.pathname.endsWith("/dns_records") && init?.method === "POST") {
    result = { id: "created-dns-record" };
  } else if (parsed.pathname === "/client/v4/zones") {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { name: string };
      result = {
        id: `zone-${body.name}`,
        name: body.name,
        status: "pending",
        name_servers: ["alice.ns.cloudflare.com", "bob.ns.cloudflare.com"],
        original_name_servers: ["ns1.external.test", "ns2.external.test"],
      };
    } else {
      result =
        !parsed.searchParams.get("name") || parsed.searchParams.get("name") === "example.com"
          ? [
              {
                id: "zone-primary",
                name: "example.com",
                status: "active",
                name_servers: ["alice.ns.cloudflare.com", "bob.ns.cloudflare.com"],
                account: { id: "account" },
              },
            ]
          : [];
    }
  }
  return new Response(JSON.stringify({ success: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});
vi.stubGlobal("fetch", cloudflareFetch);

const now = "2026-07-24T12:00:00.000Z";
const db = database.getDb();
db.prepare(
  `INSERT INTO applications(
    id, name, slug, kind, repository_url, branch, flake_output, public_port,
    created_at, updated_at
  ) VALUES ('app-1', 'Example API', 'example-api', 'web',
    'https://github.com/example/api.git', 'main', 'default', 10042, ?, ?)`,
).run(now, now);
db.prepare(
  "INSERT INTO application_domains(hostname, app_id, created_at, updated_at) VALUES (?, 'app-1', ?, ?)",
).run("api.example.com", now, now);
db.prepare(
  "INSERT INTO application_domains(hostname, app_id, created_at, updated_at) VALUES (?, 'app-1', ?, ?)",
).run("api.external.net", now, now);
const insertAssignment = db.prepare(
  `INSERT INTO domain_assignments(
    hostname, apex, target_type, app_id, state, ownership_marker, created_at, updated_at
  ) VALUES (?, ?, 'application', 'app-1', 'waiting-zone', ?, ?, ?)`,
);
insertAssignment.run("api.example.com", "example.com", "marker-api", now, now);
insertAssignment.run("api.external.net", "external.net", "marker-external", now, now);
db.prepare(
  `INSERT INTO cloudflare_config(
    singleton, account_id, api_token_encrypted, tunnel_id, tunnel_name,
    tunnel_token_encrypted, enabled, created_at, updated_at
  ) VALUES (1, 'account', ?, 'tunnel-id', 'nixship', ?, 1, ?, ?)`,
).run(
  secrets.encryptSecret("cloudflare-test-token"),
  secrets.encryptSecret("tunnel-test-token"),
  now,
  now,
);

afterAll(() => {
  vi.unstubAllGlobals();
  database.closeDb();
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});

describe("Cloudflare application routes", () => {
  it("verifies token, zone discovery, and tunnel access before saving", async () => {
    const controller = new CloudflareController();
    await controller.configure({
      accountId: "account",
      apiToken: "replacement-test-token",
      tunnelName: "nixship",
    });

    expect(apiCalls.some((call) => call.url.endsWith("/user/tokens/verify"))).toBe(true);
    expect(
      apiCalls.some((call) =>
        call.url.endsWith("/accounts/account/cfd_tunnel?per_page=1&is_deleted=false"),
      ),
    ).toBe(true);
  });

  it("rejects an inaccessible account before replacing stored configuration", async () => {
    const controller = new CloudflareController();

    await expect(
      controller.configure({
        accountId: "other-account",
        apiToken: "replacement-test-token",
        tunnelName: "nixship",
      }),
    ).rejects.toMatchObject({
      status: 502,
      code: "cloudflare_api_failed",
    });
    expect(
      db.prepare("SELECT account_id FROM cloudflare_config WHERE singleton = 1").get(),
    ).toEqual({ account_id: "account" });
  });

  it("restores working credentials when candidate ingress configuration fails", async () => {
    const before = db
      .prepare(
        "SELECT api_token_encrypted, dashboard_hostname FROM cloudflare_config WHERE singleton = 1",
      )
      .get() as { api_token_encrypted: string; dashboard_hostname: string | null };
    failNextConfiguration = true;

    await expect(
      new CloudflareController().configure({
        accountId: "account",
        apiToken: "candidate-test-token",
        tunnelName: "nixship",
        dashboardHostname: "console.example.com",
      }),
    ).rejects.toMatchObject({ code: "cloudflare_api_failed" });

    const after = db
      .prepare(
        "SELECT api_token_encrypted, dashboard_hostname FROM cloudflare_config WHERE singleton = 1",
      )
      .get() as { api_token_encrypted: string; dashboard_hostname: string | null };
    expect(secrets.decryptSecret(after.api_token_encrypted)).toBe(
      secrets.decryptSecret(before.api_token_encrypted),
    );
    expect(after.dashboard_hostname).toBe(before.dashboard_hostname);
  });

  it("refuses to overwrite a hostname already used by foreign DNS", async () => {
    db.prepare(
      "INSERT INTO application_domains(hostname, app_id, created_at, updated_at) VALUES (?, 'app-1', ?, ?)",
    ).run("occupied.example.com", now, now);
    insertAssignment.run("occupied.example.com", "example.com", "marker-occupied", now, now);
    const callOffset = apiCalls.length;

    await expect(new CloudflareController().syncIngress()).rejects.toMatchObject({
      status: 409,
      code: "domain_dns_conflict",
    });

    expect(
      db
        .prepare("SELECT state, last_error FROM domain_assignments WHERE hostname = ?")
        .get("occupied.example.com"),
    ).toMatchObject({
      state: "conflict",
      last_error: expect.stringContaining("not owned by this Nix Ship instance"),
    });
    expect(
      apiCalls
        .slice(callOffset)
        .some(
          (call) =>
            ["PUT", "DELETE"].includes(call.init?.method ?? "") &&
            call.url.endsWith("/dns_records/occupied-record"),
        ),
    ).toBe(false);

    db.prepare("DELETE FROM application_domains WHERE hostname = ?").run("occupied.example.com");
    db.prepare("DELETE FROM domain_assignments WHERE hostname = ?").run("occupied.example.com");
  });

  it("reports managed and pending-zone domains and removes stale managed DNS", async () => {
    const controller = new CloudflareController();
    await controller.syncIngress();

    expect(controller.status().routes).toMatchObject([
      {
        appId: "app-1",
        appName: "Example API",
        hostname: "api.example.com",
        publicPort: 10042,
        status: "managed",
        zoneId: "zone-primary",
      },
      {
        appId: "app-1",
        appName: "Example API",
        hostname: "api.external.net",
        publicPort: 10042,
        status: "pending",
        zoneId: "zone-external.net",
      },
    ]);
    expect(
      db
        .prepare(
          "SELECT apex, state, assigned_nameservers, original_nameservers, observed_records FROM domain_zones WHERE apex = ?",
        )
        .get("external.net"),
    ).toEqual({
      apex: "external.net",
      state: "pending-delegation",
      assigned_nameservers: JSON.stringify(["alice.ns.cloudflare.com", "bob.ns.cloudflare.com"]),
      original_nameservers: JSON.stringify(["ns1.external.test", "ns2.external.test"]),
      observed_records: "[]",
    });
    expect(
      db
        .prepare("SELECT apex, state, zone_id FROM domain_assignments WHERE hostname = ?")
        .get("api.external.net"),
    ).toEqual({
      apex: "external.net",
      state: "waiting-zone",
      zone_id: "zone-external.net",
    });

    const configurationCall = apiCalls.find((call) =>
      call.url.endsWith("/cfd_tunnel/tunnel-id/configurations"),
    );
    const configuration = JSON.parse(String(configurationCall?.init?.body)) as {
      config: { ingress: Array<{ hostname?: string; service: string }> };
    };
    expect(configuration.config.ingress).toEqual([
      { hostname: "api.example.com", service: "http://127.0.0.1:10042" },
      { service: "http_status:404" },
    ]);

    db.prepare("DELETE FROM application_domains").run();
    const insertRemovingAssignment = db.prepare(
      `INSERT INTO domain_assignments(
        hostname, apex, target_type, app_id, state, zone_id, tunnel_id,
        ownership_marker, created_at, updated_at
      ) VALUES (?, 'example.com', 'application', 'app-1', 'removing',
        'zone-primary', 'tunnel-id', ?, ?, ?)`,
    );
    insertRemovingAssignment.run("foreign.example.com", "marker-foreign", now, now);
    insertRemovingAssignment.run("changed.example.com", "marker-changed", now, now);
    insertRemovingAssignment.run("stale.example.com", "marker-stale", now, now);
    await controller.syncIngress();

    expect(controller.status().routes).toEqual([]);
    expect(
      db.prepare("SELECT hostname FROM domain_assignments WHERE state = 'removing'").all(),
    ).toEqual([]);
    expect(
      apiCalls.some(
        (call) =>
          call.init?.method === "DELETE" &&
          call.url.endsWith("/zones/zone-primary/dns_records/dns-record") &&
          call.url.includes("stale.example.com") === false,
      ),
    ).toBe(true);
    expect(
      apiCalls.some(
        (call) =>
          call.init?.method === "DELETE" &&
          (call.url.endsWith("/dns_records/foreign-record") ||
            call.url.endsWith("/dns_records/changed-record")),
      ),
    ).toBe(false);
  });
});
