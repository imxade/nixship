import { z } from "zod";
import { HttpError } from "./errors.ts";
import { remoteDefaultBranch } from "./git.ts";

const MAX_GITHUB_RESPONSE_BYTES = 256 * 1024;

const githubRepositorySchema = z.object({
  private: z.boolean(),
  archived: z.boolean(),
  default_branch: z.string(),
  html_url: z.string().url(),
  clone_url: z.string().url(),
});

export interface PublicGitHubInspection {
  provider: "github";
  repositoryUrl: string;
  branch: string;
  public: boolean;
  archived: boolean;
  deployable: boolean;
  hasFlake: boolean;
  hasFlakeLock: boolean;
  missingFiles: string[];
  exampleFlake: string | null;
  guidance: string | null;
}

export type ParsedSourceUrl =
  | { provider: "github"; repositoryUrl: string }
  | { provider: "harbur"; baseUrl: string; owner: string; repository: string };

export function parseSourceUrl(value: string): ParsedSourceUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "Enter a valid HTTPS source URL", "invalid_source_url");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw new HttpError(400, "Source URLs must be canonical HTTPS URLs", "invalid_source_url");
  }
  if (url.hostname.toLowerCase() === "github.com") {
    const parsed = parseGitHubRepositoryUrl(value);
    return {
      provider: "github",
      repositoryUrl: `https://github.com/${parsed.owner}/${parsed.repository}`,
    };
  }
  const segments = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (
    segments.length === 3 &&
    segments[0] === "repo" &&
    segments.slice(1).every((part) => /^[A-Za-z0-9_.-]+$/.test(part ?? ""))
  ) {
    return {
      provider: "harbur",
      baseUrl: url.origin,
      owner: segments[1] ?? "",
      repository: segments[2] ?? "",
    };
  }
  throw new HttpError(
    400,
    "Use a GitHub repository URL or a Harbur /repo/<owner>/<repository> URL",
    "unsupported_source_url",
  );
}

export async function inspectPublicGitHubRepository(input: {
  repositoryUrl: string;
  branch?: string;
}): Promise<PublicGitHubInspection> {
  const parsed = parseGitHubRepositoryUrl(input.repositoryUrl);
  const repositoryUrl = `https://github.com/${parsed.owner}/${parsed.repository}.git`;
  const api = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repository)}`;
  const metadataResponse = await githubFetch(api);
  let branch: string;
  let hasFlake = false;
  let hasFlakeLock = false;
  let packageJson: string | null = null;
  let archived = false;

  if (metadataResponse.status === 404) {
    throw new HttpError(
      409,
      "The repository is not publicly readable. Connect GitHub if it is private.",
      "github_auth_required",
    );
  }

  if (metadataResponse.ok) {
    const metadata = githubRepositorySchema.parse(await boundedJson(metadataResponse));
    if (metadata.private) {
      throw new HttpError(
        409,
        "The repository is private. Connect GitHub before deploying it.",
        "github_auth_required",
      );
    }
    archived = metadata.archived;
    branch =
      input.branch?.trim() || metadata.default_branch || (await remoteDefaultBranch(repositoryUrl));
    [hasFlake, hasFlakeLock, packageJson] = await Promise.all([
      githubFileExists(api, "flake.nix", branch),
      githubFileExists(api, "flake.lock", branch),
      githubTextFile(api, "package.json", branch),
    ]);
  } else if (metadataResponse.status === 403) {
    branch = input.branch?.trim() || (await remoteDefaultBranch(repositoryUrl));
    const [flakeRes, lockRes, pkgRes] = await Promise.all([
      fetch(
        `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repository}/${encodeURIComponent(branch)}/flake.nix`,
        { method: "HEAD", signal: AbortSignal.timeout(10_000) },
      ).catch(() => null),
      fetch(
        `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repository}/${encodeURIComponent(branch)}/flake.lock`,
        { method: "HEAD", signal: AbortSignal.timeout(10_000) },
      ).catch(() => null),
      fetch(
        `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repository}/${encodeURIComponent(branch)}/package.json`,
        { signal: AbortSignal.timeout(10_000) },
      )
        .then((r) => (r.ok ? r.text() : null))
        .catch(() => null),
    ]);
    hasFlake = Boolean(flakeRes?.ok);
    hasFlakeLock = Boolean(lockRes?.ok);
    packageJson = pkgRes;
  } else {
    throw new HttpError(
      502,
      `GitHub repository inspection failed with HTTP ${metadataResponse.status}`,
      "github_inspection_failed",
    );
  }

  const missingFiles = [
    ...(hasFlake ? [] : ["flake.nix"]),
    ...(hasFlakeLock ? [] : ["flake.lock"]),
  ];
  const deployable = missingFiles.length === 0 && !archived;
  return {
    provider: "github",
    repositoryUrl,
    branch,
    public: true,
    archived,
    deployable,
    hasFlake,
    hasFlakeLock,
    missingFiles,
    exampleFlake: hasFlake ? null : exampleFlake(packageJson),
    guidance: deployable
      ? null
      : archived
        ? "The repository is archived and should not be deployed until it is made active."
        : "Use the starter below as a project-specific template. Run `nix build`, replace `pkgs.lib.fakeHash` with the dependency hash Nix reports, and run `nix flake lock`. Commit flake.nix and flake.lock to the selected branch, then ask Nix Ship to inspect it again.",
  };
}

export function parseGitHubRepositoryUrl(value: string): { owner: string; repository: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "Enter a valid HTTPS GitHub repository URL", "invalid_repository_url");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw new HttpError(
      400,
      "Enter a public HTTPS GitHub repository URL",
      "invalid_repository_url",
    );
  }
  const segments = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (segments.length !== 2) {
    throw new HttpError(
      400,
      "GitHub repository URLs must contain owner and repository",
      "invalid_repository_url",
    );
  }
  const owner = segments[0] ?? "";
  const repository = (segments[1] ?? "").replace(/\.git$/i, "");
  if (![owner, repository].every((part) => /^[A-Za-z0-9_.-]+$/.test(part))) {
    throw new HttpError(
      400,
      "GitHub repository URL contains invalid characters",
      "invalid_repository_url",
    );
  }
  return { owner, repository };
}

async function githubFileExists(api: string, file: string, branch: string): Promise<boolean> {
  const response = await githubFetch(`${api}/contents/${file}?ref=${encodeURIComponent(branch)}`);
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new HttpError(
      502,
      `GitHub file inspection failed with HTTP ${response.status}`,
      "github_inspection_failed",
    );
  }
  await boundedJson(response);
  return true;
}

async function githubTextFile(api: string, file: string, branch: string): Promise<string | null> {
  const response = await githubFetch(`${api}/contents/${file}?ref=${encodeURIComponent(branch)}`);
  if (response.status === 404) return null;
  if (!response.ok) return null;
  const body = z
    .object({ encoding: z.literal("base64"), content: z.string() })
    .passthrough()
    .safeParse(await boundedJson(response));
  if (!body.success) return null;
  const decoded = Buffer.from(body.data.content.replace(/\s/g, ""), "base64");
  return decoded.byteLength <= MAX_GITHUB_RESPONSE_BYTES ? decoded.toString("utf8") : null;
}

async function githubFetch(url: string): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "nixship-source-inspector",
    "x-github-api-version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    headers,
  });
}

async function boundedJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_GITHUB_RESPONSE_BYTES) {
    throw new HttpError(
      413,
      "GitHub inspection response is too large",
      "github_response_too_large",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(502, "GitHub returned invalid JSON", "github_invalid_response");
  }
}

function exampleFlake(packageJson: string | null): string {
  let startCommand = "npm start";
  if (packageJson) {
    try {
      const parsed = JSON.parse(packageJson) as { scripts?: Record<string, string> };
      if (!parsed.scripts?.start && parsed.scripts?.dev) startCommand = "npm run dev";
    } catch {
      // A malformed package.json is untrusted repository data; use the conservative example.
    }
  }
  return `{
  description = "Nix Ship application";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      apps = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          app = pkgs.buildNpmPackage {
            pname = "app";
            version = "1.0.0";
            src = self;
            npmDepsHash = pkgs.lib.fakeHash;
            npmBuildScript = "build";
          };
        in {
          default = {
            type = "app";
            program = "\${pkgs.writeShellScript "start-app" ''
              cd \${app}/lib/node_modules/app
              exec ${startCommand}
            ''}";
          };
        });
    };
}
`;
}
