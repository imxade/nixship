import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const masterKey = Buffer.alloc(32, 7).toString("base64");

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("backup and restore", () => {
  it("round-trips application state after verifying checksums and SQLite integrity", () => {
    const root = temporaryRoot();
    const data = path.join(root, "data");
    const applicationFile = path.join(data, "applications", "app-1", "data", "value.txt");
    fs.mkdirSync(path.dirname(applicationFile), { recursive: true });
    fs.writeFileSync(applicationFile, "before backup");
    const backup = path.join(root, "backup");

    runScript("scripts/backup.ts", [backup], data);
    fs.writeFileSync(applicationFile, "after backup");
    runScript("scripts/restore.ts", [backup], data);

    expect(fs.readFileSync(applicationFile, "utf8")).toBe("before backup");
    const manifest = JSON.parse(fs.readFileSync(path.join(backup, "manifest.json"), "utf8")) as {
      format: string;
      keyMode: string;
      files: Record<string, unknown>;
    };
    expect(manifest.format).toBe("platform-backup");
    expect(manifest.keyMode).toBe("external");
    expect(Object.keys(manifest.files).sort()).toEqual(["applications.tar.gz", "platform.sqlite"]);
  }, 15000);

  it("rejects a modified archive before replacing current application state", () => {
    const root = temporaryRoot();
    const data = path.join(root, "data");
    const applicationFile = path.join(data, "applications", "app-1", "data", "value.txt");
    fs.mkdirSync(path.dirname(applicationFile), { recursive: true });
    fs.writeFileSync(applicationFile, "original");
    const backup = path.join(root, "backup");
    runScript("scripts/backup.ts", [backup], data);

    fs.appendFileSync(path.join(backup, "applications.tar.gz"), "tampered");
    fs.writeFileSync(applicationFile, "current");
    const result = runScript("scripts/restore.ts", [backup], data, false);

    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain("checksum verification failed");
    expect(fs.readFileSync(applicationFile, "utf8")).toBe("current");
  }, 15000);
});

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "platform-backup-test-"));
  roots.push(root);
  return root;
}

function runScript(
  script: string,
  arguments_: string[],
  data: string,
  requireSuccess = true,
): ReturnType<typeof spawnSync> {
  const result = spawnSync(
    process.execPath,
    [path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), script, ...arguments_],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        PLATFORM_DATA_DIR: data,
        PLATFORM_MASTER_KEY: masterKey,
      },
    },
  );
  if (requireSuccess && result.status !== 0) {
    throw new Error(`Script failed: ${result.stderr || result.stdout}`);
  }
  return result;
}
