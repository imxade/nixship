import {
  decryptSecret,
  encryptSecret,
  randomToken,
  sha256,
  signJwtRs256,
  timingSafeEqualText,
} from "./crypto.ts";
import { getDb, nowIso, setSetting, setting } from "./db.ts";
import { HttpError } from "./errors.ts";
import { preferredPublicDashboardRoute } from "./public-origin.ts";

const API_VERSION = "2026-03-10";
const API_BASE = "https://api.github.com";
const INACTIVE_WEBHOOK_URL = "https://example.com/";

interface GitHubAppRow {
  app_id: number;
  slug: string;
  client_id: string;
  client_secret_encrypted: string;
  private_key_encrypted: string;
  webhook_secret_encrypted: string;
  html_url: string;
}

export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  clone_url: string;
  default_branch: string;
  installation_id: number;
}

export function getGitHubApp(): GitHubAppRow | null {
  return (
    (getDb().prepare("SELECT * FROM github_app WHERE singleton = 1").get() as
      | GitHubAppRow
      | undefined) ?? null
  );
}

export function createManifest(baseUrl: string): {
  state: string;
  manifest: Record<string, unknown>;
} {
  const state = randomToken(24);
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  setSetting("github_manifest_state", JSON.stringify({ hash: sha256(state), expiresAt }));
  const publicBase = preferredPublicDashboardRoute()?.baseUrl ?? null;
  return {
    state,
    manifest: {
      name: `NixShip-${new URL(baseUrl).hostname.replace(/[^a-z0-9-]/gi, "-")}-${randomToken(3)}`.slice(
        0,
        34,
      ),
      url: baseUrl,
      redirect_url: `${baseUrl.replace(/\/$/, "")}/api/github/callback`,
      setup_url: `${baseUrl.replace(/\/$/, "")}/github/complete`,
      setup_on_update: true,
      public: false,
      default_permissions: {
        contents: "read",
        metadata: "read",
      },
      default_events: ["push"],
      hook_attributes: {
        url: publicBase ? `${publicBase}/api/github/webhook` : INACTIVE_WEBHOOK_URL,
        active: Boolean(publicBase),
      },
    },
  };
}

export function verifyManifestState(state: string): void {
  const encoded = setting("github_manifest_state");
  if (!encoded)
    throw new HttpError(400, "GitHub connection state is missing", "github_state_missing");
  const parsed = JSON.parse(encoded) as { hash: string; expiresAt: string };
  if (
    !timingSafeEqualText(parsed.hash, sha256(state)) ||
    Date.parse(parsed.expiresAt) < Date.now()
  ) {
    throw new HttpError(
      400,
      "GitHub connection state is invalid or expired",
      "github_state_invalid",
    );
  }
  getDb().prepare("DELETE FROM settings WHERE key = 'github_manifest_state'").run();
}

export async function convertManifest(code: string): Promise<GitHubAppRow> {
  const response = await githubFetch(
    `${API_BASE}/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: "POST",
      headers: githubHeaders(),
    },
  );
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok)
    throw new HttpError(502, githubApiError(body), "github_manifest_conversion_failed");
  const required = [
    "id",
    "slug",
    "client_id",
    "client_secret",
    "pem",
    "webhook_secret",
    "html_url",
  ] as const;
  for (const key of required)
    if (!body[key]) throw new Error(`GitHub manifest response omitted ${key}`);
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO github_app(singleton, app_id, slug, client_id, client_secret_encrypted, private_key_encrypted,
        webhook_secret_encrypted, html_url, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET app_id=excluded.app_id, slug=excluded.slug, client_id=excluded.client_id,
        client_secret_encrypted=excluded.client_secret_encrypted, private_key_encrypted=excluded.private_key_encrypted,
        webhook_secret_encrypted=excluded.webhook_secret_encrypted, html_url=excluded.html_url, updated_at=excluded.updated_at`,
    )
    .run(
      Number(body.id),
      String(body.slug),
      String(body.client_id),
      encryptSecret(String(body.client_secret)),
      encryptSecret(String(body.pem)),
      encryptSecret(String(body.webhook_secret)),
      String(body.html_url),
      now,
      now,
    );
  const created = getGitHubApp();
  if (!created) throw new Error("GitHub App credentials were not persisted");
  return created;
}

export function appJwt(): string {
  const app = getGitHubApp();
  if (!app) throw new HttpError(409, "GitHub is not connected", "github_not_connected");
  const now = Math.floor(Date.now() / 1000);
  return signJwtRs256(
    { iat: now - 60, exp: now + 9 * 60, iss: app.app_id },
    decryptSecret(app.private_key_encrypted),
  );
}

export async function syncInstallations(): Promise<number> {
  const installations: Array<Record<string, unknown>> = [];
  for (let page = 1; ; page++) {
    const response = await githubFetch(`${API_BASE}/app/installations?per_page=100&page=${page}`, {
      headers: githubHeaders(appJwt()),
    });
    const body = (await response.json()) as unknown;
    if (!response.ok || !Array.isArray(body)) {
      throw new HttpError(502, githubApiError(body), "github_installations_failed");
    }
    installations.push(...(body as Array<Record<string, unknown>>));
    if (body.length < 100) break;
  }
  const now = nowIso();
  const statement = getDb().prepare(
    `INSERT INTO github_installations(id, account_login, account_type, repository_selection, suspended_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET account_login=excluded.account_login, account_type=excluded.account_type,
       repository_selection=excluded.repository_selection, suspended_at=excluded.suspended_at, updated_at=excluded.updated_at`,
  );
  getDb().transaction(() => {
    for (const item of installations) {
      const account = item.account as Record<string, unknown>;
      statement.run(
        Number(item.id),
        String(account.login),
        String(account.type),
        String(item.repository_selection),
        item.suspended_at ? String(item.suspended_at) : null,
        String(item.created_at ?? now),
        now,
      );
    }
    if (installations.length === 0) {
      getDb()
        .prepare(
          "UPDATE github_installations SET suspended_at = COALESCE(suspended_at, ?), updated_at = ?",
        )
        .run(now, now);
    } else {
      const ids = installations.map((item) => Number(item.id));
      getDb()
        .prepare(
          `UPDATE github_installations
           SET suspended_at = COALESCE(suspended_at, ?), updated_at = ?
           WHERE id NOT IN (${ids.map(() => "?").join(",")})`,
        )
        .run(now, now, ...ids);
    }
  })();
  return installations.length;
}

export async function installationToken(installationId: number): Promise<string> {
  const response = await githubFetch(
    `${API_BASE}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: githubHeaders(appJwt()),
    },
  );
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok || !body.token) {
    throw new HttpError(502, githubApiError(body), "github_installation_token_failed");
  }
  return String(body.token);
}

export async function listRepositories(): Promise<GitHubRepository[]> {
  const installations = getDb()
    .prepare(
      "SELECT id FROM github_installations WHERE suspended_at IS NULL ORDER BY account_login",
    )
    .all() as Array<{ id: number }>;
  const repositories = new Map<number, GitHubRepository>();
  for (const installation of installations) {
    const token = await installationToken(installation.id);
    let page = 1;
    let fetched = 0;
    while (true) {
      const response = await githubFetch(
        `${API_BASE}/installation/repositories?per_page=100&page=${page}`,
        {
          headers: githubHeaders(token),
        },
      );
      const body = (await response.json()) as Record<string, unknown>;
      if (!response.ok || !Array.isArray(body.repositories)) {
        throw new HttpError(502, githubApiError(body), "github_repositories_failed");
      }
      const pageRepositories = body.repositories as Array<Record<string, unknown>>;
      for (const repository of pageRepositories) {
        repositories.set(Number(repository.id), {
          id: Number(repository.id),
          name: String(repository.name),
          full_name: String(repository.full_name),
          private: Boolean(repository.private),
          clone_url: String(repository.clone_url),
          default_branch: String(repository.default_branch),
          installation_id: installation.id,
        });
      }
      fetched += pageRepositories.length;
      const total = Number(body.total_count);
      if (
        pageRepositories.length < 100 ||
        (Number.isSafeInteger(total) && total >= 0 && fetched >= total)
      ) {
        break;
      }
      page++;
    }
  }
  return [...repositories.values()].sort((a, b) => a.full_name.localeCompare(b.full_name));
}

export async function repositoryHead(
  repositoryUrl: string,
  installationId: number,
  branch: string,
): Promise<string> {
  const match = repositoryUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) throw new Error("GitHub repository URL is not recognized");
  const owner = match[1];
  const repository = match[2];
  if (!owner || !repository) throw new Error("GitHub repository URL is incomplete");
  const token = await installationToken(installationId);
  const response = await githubFetch(
    `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commits/${encodeURIComponent(branch)}`,
    { headers: githubHeaders(token) },
  );
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok || !body.sha)
    throw new HttpError(502, githubApiError(body), "github_branch_head_failed");
  return String(body.sha);
}

export function gitAuthenticationEnvironment(installationTokenValue?: string): NodeJS.ProcessEnv {
  if (!installationTokenValue) return { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const basicCredentials = Buffer.from(`x-access-token:${installationTokenValue}`).toString(
    "base64",
  );
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basicCredentials}`,
  };
}

export async function updateAppWebhook(publicBaseUrl: string | null): Promise<boolean> {
  const app = getGitHubApp();
  if (!app) return false;
  const url = publicBaseUrl
    ? `${publicBaseUrl.replace(/\/$/, "")}/api/github/webhook`
    : INACTIVE_WEBHOOK_URL;
  const response = await githubFetch(`${API_BASE}/app/hook/config`, {
    method: "PATCH",
    headers: githubHeaders(appJwt()),
    body: JSON.stringify({
      url,
      content_type: "json",
      insecure_ssl: "0",
      secret: decryptSecret(app.webhook_secret_encrypted),
    }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new HttpError(502, githubApiError(body), "github_webhook_update_failed");
  }
  return true;
}

export function webhookSecret(): string {
  const app = getGitHubApp();
  if (!app) throw new HttpError(409, "GitHub is not connected", "github_not_connected");
  return decryptSecret(app.webhook_secret_encrypted);
}

export function installUrl(): string {
  const app = getGitHubApp();
  if (!app) throw new HttpError(409, "GitHub is not connected", "github_not_connected");
  return `https://github.com/apps/${app.slug}/installations/new`;
}

function githubHeaders(token?: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "x-github-api-version": API_VERSION,
    "user-agent": "NixShip/0.1",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function githubApiError(body: unknown): string {
  if (body && typeof body === "object" && "message" in body)
    return `GitHub API: ${String(body.message)}`;
  return "GitHub API request failed";
}

function githubFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
}
