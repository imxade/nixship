import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensureDataDirectories, paths } from "../src/server/paths.ts";

ensureDataDirectories();
const permissionTargets = [
  paths.data,
  paths.repositories,
  paths.releases,
  paths.appData,
  paths.logs,
  paths.runtime,
  paths.secrets,
  paths.backups,
  paths.database,
  paths.keyFile,
  paths.setupTokenFile,
].filter((target) => fs.existsSync(target));
const permissionChecks = permissionTargets.map((target) => {
  const mode = fs.statSync(target).mode & 0o777;
  return { target, mode: mode.toString(8), secure: (mode & 0o077) === 0 };
});

const listed = spawnSync("git", ["ls-files", "-z"], {
  cwd: process.cwd(),
  encoding: "utf8",
  timeout: 10_000,
});
if (listed.error || listed.status !== 0) {
  throw new Error(`Unable to enumerate tracked files: ${listed.error?.message ?? listed.stderr}`);
}

const forbiddenPaths = [
  /(^|\/)\.env($|\.)/i,
  /(^|\/)(master\.key|setup-token\.txt|platform\.sqlite(?:-wal|-shm)?)$/i,
  /\.(?:p12|pfx|key|sqlite3?)$/i,
];
const secretPatterns = [
  { name: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "github-fine-grained-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/ },
  { name: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
];
const findings: Array<{ file: string; reason: string }> = [];

for (const file of listed.stdout.split("\0").filter(Boolean)) {
  if (
    path.basename(file) !== ".env.example" &&
    forbiddenPaths.some((pattern) => pattern.test(file))
  ) {
    findings.push({ file, reason: "sensitive-file-path" });
    continue;
  }
  const absolute = path.resolve(process.cwd(), file);
  // A tracked file can be absent during a reviewed rename or deletion in a dirty worktree.
  if (!fs.existsSync(absolute)) continue;
  const stats = fs.statSync(absolute);
  if (!stats.isFile() || stats.size > 2 * 1024 * 1024 || file === "pnpm-lock.yaml") continue;
  const contents = fs.readFileSync(absolute, "utf8");
  for (const secret of secretPatterns) {
    if (secret.pattern.test(contents)) findings.push({ file, reason: secret.name });
  }
}

const secure = permissionChecks.every((check) => check.secure) && findings.length === 0;
console.log(JSON.stringify({ permissionChecks, secretScan: { findings }, secure }, null, 2));
process.exit(secure ? 0 : 1);
