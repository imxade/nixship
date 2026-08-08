import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractHarburArchive,
  harburEventPageSchema,
  isPrivateIpAddress,
  validateHarburEventPage,
  validateZipCentralDirectory,
} from "../../src/server/harbur.ts";
import { shouldQueueHarburRevision } from "../../src/server/harbur-reconciler.ts";
import { recoveryRevision } from "../../src/server/runtime.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Harbur integration", () => {
  it("classifies private and public network addresses", () => {
    expect(isPrivateIpAddress("127.0.0.1")).toBe(true);
    expect(isPrivateIpAddress("10.20.30.40")).toBe(true);
    expect(isPrivateIpAddress("169.254.169.254")).toBe(true);
    expect(isPrivateIpAddress("::1")).toBe(true);
    expect(isPrivateIpAddress("fd00::1")).toBe(true);
    expect(isPrivateIpAddress("8.8.8.8")).toBe(false);
    expect(isPrivateIpAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("validates monotonic exact-revision event pages", () => {
    const revision = "a".repeat(64);
    expect(
      harburEventPageSchema.parse({
        events: [
          {
            cursor: 4,
            id: `owner/repo:${revision}`,
            type: "repository.snapshot",
            repositoryId: "owner/repo",
            revision,
            createdAt: "2026-08-09T00:00:00.000Z",
          },
        ],
        nextCursor: 4,
        hasMore: false,
      }).nextCursor,
    ).toBe(4);
    expect(shouldQueueHarburRevision(false)).toBe(true);
    expect(shouldQueueHarburRevision(true)).toBe(false);
    expect(() =>
      validateHarburEventPage(
        {
          events: [],
          nextCursor: 3,
          hasMore: false,
        },
        4,
      ),
    ).toThrow("inconsistent event cursor");
  });

  it("reuses an exact Harbur revision during runtime recovery", () => {
    const revision = "b".repeat(64);
    expect(
      recoveryRevision({ source_provider: "harbur" }, [
        { commit_sha: revision },
        { commit_sha: null },
      ]),
    ).toBe(revision);
    expect(recoveryRevision({ source_provider: "github" }, [{ commit_sha: revision }])).toBeNull();
  });

  it("extracts a bounded snapshot into a fresh release", async () => {
    const root = temporaryDirectory();
    const release = path.join(root, "release");
    const zip = new JSZip();
    zip.file("flake.nix", "{}\n");
    zip.file("flake.lock", "{}\n");
    zip.file("src/index.ts", "export {};\n");
    await extractHarburArchive(
      Buffer.from(await zip.generateAsync({ type: "uint8array" })),
      release,
    );
    expect(fs.readFileSync(path.join(release, "src/index.ts"), "utf8")).toBe("export {};\n");
  });

  it("rejects archive traversal even when the ZIP parser sanitizes it", async () => {
    const root = temporaryDirectory();
    const zip = new JSZip();
    zip.file("flake.nix", "{}\n");
    zip.file("flake.lock", "{}\n");
    zip.file("../outside", "secret");
    await expect(
      extractHarburArchive(
        Buffer.from(await zip.generateAsync({ type: "uint8array" })),
        path.join(root, "release"),
      ),
    ).rejects.toThrow("unsafe path");
    expect(fs.existsSync(path.join(root, "outside"))).toBe(false);
  });

  it("rejects a declared ZIP bomb before decompression", async () => {
    const zip = new JSZip();
    zip.file("flake.nix", "{}\n");
    const archive = Buffer.from(await zip.generateAsync({ type: "uint8array" }));
    const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(central).toBeGreaterThanOrEqual(0);
    archive.writeUInt32LE(128 * 1024 * 1024 + 1, central + 24);
    expect(() => validateZipCentralDirectory(archive)).toThrow("oversized file");
  });
});

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "harbur-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
