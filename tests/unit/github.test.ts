import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "platform-github-test-"));
process.env.PLATFORM_DATA_DIR = dataDirectory;
process.env.PLATFORM_MASTER_KEY = Buffer.alloc(32, 31).toString("base64");

const [{ createManifest, gitAuthenticationEnvironment, listRepositories }, database, secrets] =
  await Promise.all([
    import("../../src/server/github.ts"),
    import("../../src/server/db.ts"),
    import("../../src/server/crypto.ts"),
  ]);

afterEach(() => {
  vi.unstubAllGlobals();
  database.getDb().exec("DELETE FROM github_installations; DELETE FROM github_app;");
});

afterAll(() => {
  delete process.env.PLATFORM_PUBLIC_URL;
  database.closeDb();
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});

describe("GitHub App manifest", () => {
  it("provides the required public hook URL but keeps it inactive for a LAN-only node", async () => {
    const { config } = await import("../../src/server/config.ts");
    config.PLATFORM_PUBLIC_URL = "";
    const { manifest } = createManifest("http://127.0.0.1:3000");

    expect(manifest.hook_attributes).toEqual({
      url: "https://example.com/",
      active: false,
    });
    expect(manifest.default_events).toEqual(["push"]);
    expect(manifest.setup_on_update).toBe(true);
  });

  it("activates the webhook only for the configured public origin", async () => {
    const { config } = await import("../../src/server/config.ts");
    config.PLATFORM_PUBLIC_URL = "https://console.example.com/";
    const { manifest } = createManifest("http://127.0.0.1:3000");

    expect(manifest.hook_attributes).toEqual({
      url: "https://console.example.com/api/github/webhook",
      active: true,
    });
  });
});

describe("GitHub repository discovery", () => {
  it("loads every repository page beyond the previous ten-page ceiling", async () => {
    const privateKey = crypto
      .generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const now = new Date().toISOString();
    database
      .getDb()
      .prepare(
        `INSERT INTO github_app(
          singleton, app_id, slug, client_id, client_secret_encrypted,
          private_key_encrypted, webhook_secret_encrypted, html_url, created_at, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        123,
        "platform-test",
        "client",
        secrets.encryptSecret("client-secret"),
        secrets.encryptSecret(privateKey),
        secrets.encryptSecret("webhook-secret"),
        "https://github.com/apps/platform-test",
        now,
        now,
      );
    database
      .getDb()
      .prepare(
        `INSERT INTO github_installations(
          id, account_login, account_type, repository_selection, suspended_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(456, "owner", "User", "all", now, now);

    const repositoryRequests: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/access_tokens")) {
          return Response.json({ token: "installation-token" });
        }
        const page = Number(url.searchParams.get("page"));
        repositoryRequests.push(page);
        const start = (page - 1) * 100;
        const count = Math.max(0, Math.min(100, 1001 - start));
        return Response.json({
          total_count: 1001,
          repositories: Array.from({ length: count }, (_, offset) => {
            const id = start + offset + 1;
            return {
              id,
              name: `repo-${id}`,
              full_name: `owner/repo-${id}`,
              private: id % 2 === 0,
              clone_url: `https://github.com/owner/repo-${id}.git`,
              default_branch: "trunk",
            };
          }),
        });
      }),
    );

    const repositories = await listRepositories();

    expect(repositories).toHaveLength(1001);
    expect(repositoryRequests).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(repositories.some((repository) => repository.full_name === "owner/repo-1001")).toBe(
      true,
    );
  });
});

describe("GitHub Git authentication", () => {
  it("uses GitHub's x-access-token HTTP Basic credentials without changing the repository URL", () => {
    const environment = gitAuthenticationEnvironment("installation-secret");

    expect(environment.GIT_TERMINAL_PROMPT).toBe("0");
    expect(environment.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraHeader");
    expect(environment.GIT_CONFIG_VALUE_0).toMatch(/^Authorization: Basic /);
    const encoded = environment.GIT_CONFIG_VALUE_0?.replace("Authorization: Basic ", "") ?? "";
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(
      "x-access-token:installation-secret",
    );
    expect(environment.GIT_CONFIG_VALUE_0).not.toContain("installation-secret");
  });
});
