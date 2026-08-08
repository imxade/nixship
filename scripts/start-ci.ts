import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TEST_ADMIN_USERNAME = "qwerty123456";
const TEST_ADMIN_PASSWORD = "qwerty123456";
const serverEntry = path.join(process.cwd(), "dist-server", "server.js");

if (!fs.existsSync(serverEntry)) {
  throw new Error("The production server is not built. Run pnpm build before pnpm start:ci");
}

const configuredDataDirectory =
  process.env.CI_DATA_DIR ??
  `${process.env.E2E_DATA_DIR ?? path.join(process.cwd(), ".e2e-data")}-ci`;
const dataDirectory = path.resolve(configuredDataDirectory);
const basename = path.basename(dataDirectory);
if (!basename.startsWith(".e2e-data") && !basename.startsWith("platform-e2e")) {
  throw new Error(`Refusing to clear an unsafe CI data path: ${dataDirectory}`);
}

fs.rmSync(dataDirectory, { recursive: true, force: true });
Object.assign(process.env, {
  HOSTNAME: "127.0.0.1",
  NODE_ENV: "production",
  PLATFORM_DATA_DIR: dataDirectory,
});
process.env.PORT ??= "3001";
process.env.MIN_FREE_DISK_MB ??= "128";
process.env.MIN_FREE_MEMORY_MB ??= "64";
process.env.QUICK_TUNNELS_ENABLED ??= "false";

const [{ getDb, closeDb, nowIso }, { hashPassword, randomToken }] = await Promise.all([
  import("../src/server/db.ts"),
  import("../src/server/crypto.ts"),
]);

const now = nowIso();
const [ownerPasswordHash, adminPasswordHash] = await Promise.all([
  hashPassword(randomToken(32)),
  hashPassword(TEST_ADMIN_PASSWORD),
]);
const db = getDb();
db.transaction(() => {
  const insert = db.prepare(
    `INSERT INTO users(
      id, username, password_hash, role, disabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?)`,
  );
  insert.run(crypto.randomUUID(), "ci-owner", ownerPasswordHash, "owner", now, now);
  insert.run(crypto.randomUUID(), TEST_ADMIN_USERNAME, adminPasswordHash, "admin", now, now);
})();
closeDb();

console.warn(
  `INSECURE TEST MODE: loopback-only admin ${TEST_ADMIN_USERNAME}/${TEST_ADMIN_PASSWORD}`,
);
const child = spawn(process.execPath, [serverEntry], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => child.kill(signal));
}
const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
  (resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  },
);
process.exitCode = exit.signal ? 1 : (exit.code ?? 1);
