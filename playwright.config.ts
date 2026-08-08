import { defineConfig } from "@playwright/test";

const portBase = Number(process.env.E2E_PORT_BASE ?? 3000);
if (!Number.isInteger(portBase) || portBase < 1 || portBase > 65532) {
  throw new Error("E2E_PORT_BASE must leave room for four valid TCP ports");
}
const setupPort = portBase;
const adminPort = portBase + 1;
const nativeAuthPort = portBase + 2;
const developmentPort = portBase + 3;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  workers: 1,
  use: { trace: "retain-on-failure" },
  projects: [
    {
      name: "production-setup",
      testMatch: /setup\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${setupPort}` },
    },
    {
      name: "ci-admin",
      testMatch: /ci-admin\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${adminPort}` },
    },
    {
      name: "native-auth",
      testMatch: /native-auth\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${nativeAuthPort}`, javaScriptEnabled: false },
    },
    {
      name: "development-runtime",
      testMatch: /development-runtime\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${developmentPort}` },
    },
  ],
  webServer: [
    {
      command: "pnpm exec tsx tests/e2e/start-server.ts",
      url: `http://127.0.0.1:${setupPort}/api/setup/status`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        E2E_PORT: String(setupPort),
      },
    },
    {
      command: "pnpm start:ci",
      url: `http://127.0.0.1:${adminPort}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        PORT: String(adminPort),
      },
    },
    {
      command: "pnpm exec tsx tests/e2e/start-server.ts",
      url: `http://127.0.0.1:${nativeAuthPort}/api/setup/status`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        E2E_INSTANCE: "native",
        E2E_PORT: String(nativeAuthPort),
      },
    },
    {
      command: "pnpm exec tsx tests/e2e/start-server.ts",
      url: `http://127.0.0.1:${developmentPort}/api/setup/status`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        E2E_COMMAND: "dev",
        E2E_INSTANCE: "development",
        E2E_PORT: String(developmentPort),
      },
    },
  ],
});
