import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectPublicGitHubRepository,
  parseGitHubRepositoryUrl,
  parseSourceUrl,
} from "../../src/server/source-inspection.ts";

afterEach(() => vi.restoreAllMocks());

describe("public GitHub source inspection", () => {
  it("classifies canonical GitHub and Harbur repository URLs", () => {
    expect(parseSourceUrl("https://github.com/imxade/kitsy")).toEqual({
      provider: "github",
      repositoryUrl: "https://github.com/imxade/kitsy",
    });
    expect(parseSourceUrl("https://harbur.vercel.app/repo/rb/kitsy")).toEqual({
      provider: "harbur",
      baseUrl: "https://harbur.vercel.app",
      owner: "rb",
      repository: "kitsy",
    });
    expect(() => parseSourceUrl("http://harbur.vercel.app/repo/rb/kitsy")).toThrowError(
      /canonical HTTPS/,
    );
  });

  it("requires both locked flake files and returns a starter example when they are absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (!url.includes("/contents/")) {
          return json({
            private: false,
            archived: false,
            default_branch: "master",
            html_url: "https://github.com/example/no-flake",
            clone_url: "https://github.com/example/no-flake.git",
          });
        }
        if (url.includes("package.json")) {
          return json({
            encoding: "base64",
            content: Buffer.from(JSON.stringify({ scripts: { start: "next start" } })).toString(
              "base64",
            ),
          });
        }
        return json({ message: "Not Found" }, 404);
      }),
    );

    const result = await inspectPublicGitHubRepository({
      repositoryUrl: "https://github.com/example/no-flake",
    });
    expect(result).toMatchObject({
      branch: "master",
      deployable: false,
      hasFlake: false,
      hasFlakeLock: false,
      missingFiles: ["flake.nix", "flake.lock"],
    });
    expect(result.guidance).toContain("Commit flake.nix and flake.lock");
    expect(result.exampleFlake).toContain("buildNpmPackage");
    expect(result.exampleFlake).toContain("npm start");
  });

  it("distinguishes a non-public repository from a missing flake", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ message: "Not Found" }, 404)),
    );
    await expect(
      inspectPublicGitHubRepository({ repositoryUrl: "https://github.com/example/private" }),
    ).rejects.toMatchObject({ code: "github_auth_required" });
  });

  it("accepts only an exact HTTPS github.com owner/repository URL", () => {
    expect(parseGitHubRepositoryUrl("https://github.com/imxade/kitsy.git")).toEqual({
      owner: "imxade",
      repository: "kitsy",
    });
    for (const value of [
      "http://github.com/imxade/kitsy",
      "https://github.com/imxade/kitsy/issues",
      "https://github.com@example.test/imxade/kitsy",
      "https://github.com/imxade/kitsy?token=secret",
    ]) {
      expect(() => parseGitHubRepositoryUrl(value)).toThrow();
    }
  });
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
