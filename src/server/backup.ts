import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { getDb } from "./db.ts";
import { ensureDataDirectories, paths } from "./paths.ts";
import { matchesProcessIdentity } from "./process-identity.ts";

const backupFileSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative(),
});

const backupManifestSchema = z
  .object({
    format: z.literal("platform-backup"),
    version: z.literal(1),
    createdAt: z.string().datetime(),
    sourceDataDir: z.string().min(1),
    keyMode: z.enum(["local", "external", "none"]),
    files: z.record(z.string(), backupFileSchema),
  })
  .strict();

export type BackupManifest = z.infer<typeof backupManifestSchema>;

export async function createBackup(targetValue?: string): Promise<string> {
  ensureDataDirectories();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.resolve(targetValue || path.join(paths.backups, stamp));
  if (fs.existsSync(target)) throw new Error(`Backup target already exists: ${target}`);

  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(parent, ".platform-backup-"));
  fs.chmodSync(staging, 0o700);
  try {
    const databaseTarget = path.join(staging, "platform.sqlite");
    await getDb().backup(databaseTarget);

    const keyMode = backupKeyMode();
    if (keyMode === "local") {
      fs.copyFileSync(paths.keyFile, path.join(staging, "master.key"));
      fs.chmodSync(path.join(staging, "master.key"), 0o600);
    }

    runTar(["-C", paths.data, "-czf", path.join(staging, "applications.tar.gz"), "applications"]);

    const fileNames = fs
      .readdirSync(staging, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
    const files = Object.fromEntries(
      fileNames.map((name) => {
        const file = path.join(staging, name);
        return [name, { sha256: fileSha256(file), bytes: fs.statSync(file).size }];
      }),
    );
    const manifest: BackupManifest = {
      format: "platform-backup",
      version: 1,
      createdAt: new Date().toISOString(),
      sourceDataDir: paths.data,
      keyMode,
      files,
    };
    fs.writeFileSync(
      path.join(staging, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      {
        mode: 0o600,
        flag: "wx",
      },
    );
    fs.renameSync(staging, target);
    return target;
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function verifyBackup(sourceValue: string): BackupManifest {
  const source = path.resolve(sourceValue);
  const manifestPath = path.join(source, "manifest.json");
  if (!fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Backup directory does not exist: ${source}`);
  }
  if (!fs.existsSync(manifestPath)) throw new Error("Backup is missing manifest.json");
  const manifest = backupManifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
  const expectedNames = new Set(["platform.sqlite", "applications.tar.gz"]);
  if (manifest.keyMode === "local") expectedNames.add("master.key");
  const actualNames = new Set(Object.keys(manifest.files));
  if (
    actualNames.size !== expectedNames.size ||
    [...expectedNames].some((name) => !actualNames.has(name))
  ) {
    throw new Error("Backup manifest has an unexpected file set");
  }
  for (const [name, expected] of Object.entries(manifest.files)) {
    const file = path.join(source, name);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new Error(`Backup is missing ${name}`);
    if (stat.size !== expected.bytes || fileSha256(file) !== expected.sha256) {
      throw new Error(`Backup checksum verification failed for ${name}`);
    }
  }
  validateKeyAvailability(source, manifest.keyMode);
  validateDatabase(path.join(source, "platform.sqlite"));
  validateApplicationArchive(path.join(source, "applications.tar.gz"));
  return manifest;
}

export function restoreBackup(sourceValue: string): void {
  const source = path.resolve(sourceValue);
  const manifest = verifyBackup(source);
  ensureNoActiveRuntime();
  ensureDataDirectories();

  const staging = fs.mkdtempSync(path.join(paths.data, ".restore-stage-"));
  const rollback = fs.mkdtempSync(path.join(paths.data, ".restore-rollback-"));
  const moved: Array<{ from: string; to: string }> = [];
  const installed: string[] = [];
  try {
    const stagedDatabase = path.join(staging, "platform.sqlite");
    fs.copyFileSync(path.join(source, "platform.sqlite"), stagedDatabase);
    fs.chmodSync(stagedDatabase, 0o600);
    if (manifest.keyMode === "local") {
      fs.copyFileSync(path.join(source, "master.key"), path.join(staging, "master.key"));
      fs.chmodSync(path.join(staging, "master.key"), 0o600);
    }
    runTar([
      "-C",
      staging,
      "--no-same-owner",
      "--no-same-permissions",
      "-xzf",
      path.join(source, "applications.tar.gz"),
    ]);
    const stagedApplications = path.join(staging, "applications");
    if (!fs.statSync(stagedApplications, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error("Backup archive did not contain the applications directory");
    }

    for (const current of [
      paths.database,
      `${paths.database}-wal`,
      `${paths.database}-shm`,
      paths.appData,
      paths.keyFile,
    ]) {
      if (!fs.existsSync(current)) continue;
      const saved = path.join(rollback, path.basename(current));
      fs.renameSync(current, saved);
      moved.push({ from: saved, to: current });
    }

    fs.renameSync(stagedDatabase, paths.database);
    installed.push(paths.database);
    fs.renameSync(stagedApplications, paths.appData);
    installed.push(paths.appData);
    if (manifest.keyMode === "local") {
      fs.renameSync(path.join(staging, "master.key"), paths.keyFile);
      installed.push(paths.keyFile);
    }
    validateDatabase(paths.database);
    fs.rmSync(rollback, { recursive: true, force: true });
  } catch (error) {
    for (const target of installed.reverse()) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    for (const item of moved.reverse()) {
      if (fs.existsSync(item.from)) fs.renameSync(item.from, item.to);
    }
    throw error;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(rollback, { recursive: true, force: true });
  }
}

function backupKeyMode(): BackupManifest["keyMode"] {
  if (process.env.PLATFORM_MASTER_KEY?.trim()) {
    decodeMasterKey(process.env.PLATFORM_MASTER_KEY);
    return "external";
  }
  if (fs.existsSync(paths.keyFile)) return "local";
  const encryptedRows = getDb()
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM app_environment) +
        (SELECT COUNT(*) FROM github_app) +
        (SELECT COUNT(*) FROM cloudflare_config) AS count`,
    )
    .get() as { count: number };
  if (encryptedRows.count > 0) {
    throw new Error("Encrypted state exists but no master key is available");
  }
  return "none";
}

function validateKeyAvailability(source: string, mode: BackupManifest["keyMode"]): void {
  if (mode === "local") {
    decodeMasterKey(fs.readFileSync(path.join(source, "master.key"), "utf8"));
  } else if (mode === "external") {
    const value = process.env.PLATFORM_MASTER_KEY;
    if (!value) {
      throw new Error("This backup requires PLATFORM_MASTER_KEY to be present during restore");
    }
    decodeMasterKey(value);
  }
}

function decodeMasterKey(value: string): Buffer {
  const decoded = Buffer.from(value.trim(), "base64");
  if (decoded.length !== 32) throw new Error("Master key must be 32 bytes encoded as base64");
  return decoded;
}

function validateDatabase(file: string): void {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const integrity = database.pragma("integrity_check") as Array<{ integrity_check: string }>;
    if (!integrity.every((row) => row.integrity_check === "ok")) {
      throw new Error("Backup database failed SQLite integrity_check");
    }
    const foreignKeys = database.pragma("foreign_key_check") as unknown[];
    if (foreignKeys.length > 0) throw new Error("Backup database failed foreign_key_check");
  } finally {
    database.close();
  }
}

function validateApplicationArchive(file: string): void {
  const listing = runTar(["-tzf", file], true);
  for (const rawName of listing.split("\n").filter(Boolean)) {
    const name = rawName.replace(/\/$/, "");
    if (
      path.posix.isAbsolute(name) ||
      name.split("/").includes("..") ||
      (name !== "applications" && !name.startsWith("applications/"))
    ) {
      throw new Error(`Backup archive contains an unsafe path: ${rawName}`);
    }
  }
}

function ensureNoActiveRuntime(): void {
  const lockPath = path.join(paths.runtime, "runtime.lock");
  if (!fs.existsSync(lockPath)) return;
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
      pid?: number;
      processGroupId?: number;
      startTicks?: string | null;
      commandHash?: string | null;
      commandSummary?: string | null;
    };
    if (
      lock.pid &&
      matchesProcessIdentity({
        pid: lock.pid,
        process_group_id: lock.processGroupId ?? lock.pid,
        process_start_ticks: lock.startTicks ?? null,
        process_command_hash: lock.commandHash ?? null,
        process_command_summary: lock.commandSummary ?? null,
      })
    ) {
      throw new Error(`Stop Nix Ship before restoring; the control plane PID is ${lock.pid}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Stop Nix Ship")) throw error;
  }
  fs.rmSync(lockPath, { force: true });
}

function fileSha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function runTar(arguments_: string[], capture = false): string {
  const result = spawnSync("tar", arguments_, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "ignore", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`tar failed: ${result.stderr?.trim() || `exit ${result.status}`}`);
  }
  return result.stdout ?? "";
}
