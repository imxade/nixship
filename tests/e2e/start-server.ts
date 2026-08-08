import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const baseDataDirectory = process.env.E2E_DATA_DIR || path.join(process.cwd(), ".e2e-data");
const instance = process.env.E2E_INSTANCE?.trim();
const dataDirectory = path.resolve(
  instance ? `${baseDataDirectory}-${instance}` : baseDataDirectory,
);
const basename = path.basename(dataDirectory);
if (!basename.startsWith(".e2e-data") && !basename.startsWith("platform-e2e")) {
  throw new Error(`Refusing to clear an unsafe end-to-end data path: ${dataDirectory}`);
}
fs.rmSync(dataDirectory, { recursive: true, force: true });

const command = process.env.E2E_COMMAND === "dev" ? "dev" : "start";
const child = spawn("pnpm", [command], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: {
    ...process.env,
    HOSTNAME: "127.0.0.1",
    PORT: process.env.E2E_PORT ?? "3000",
    PLATFORM_DATA_DIR: dataDirectory,
    MIN_FREE_DISK_MB: "128",
    MIN_FREE_MEMORY_MB: "64",
    QUICK_TUNNELS_ENABLED: "false",
  },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}
child.once("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
