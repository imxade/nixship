import { describe, expect, it } from "vitest";
import {
  buildWorkloadEnvironment,
  workloadBaseEnvironment,
} from "../../src/server/process-supervisor.ts";

describe("workload environment boundary", () => {
  it("inherits only the explicit compatibility set", () => {
    expect(
      workloadBaseEnvironment({
        PATH: "/bin",
        HOME: "/home/example",
        LANG: "en_US.UTF-8",
        LC_CTYPE: "C.UTF-8",
        LOCALE_ARCHIVE: "/run/current-system/sw/lib/locale/locale-archive",
        NIX_REMOTE: "daemon",
        SSL_CERT_FILE: "/etc/ssl/certs/ca-bundle.crt",
        TZDIR: "/etc/zoneinfo",
        UNDEFINED_COMPATIBILITY_VALUE: undefined,
        ARBITRARY_HOST_SECRET: "arbitrary-secret",
        GITHUB_TOKEN: "github-secret",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
        SSH_AUTH_SOCK: "/run/user/1000/agent.sock",
        NODE_OPTIONS: "--require=/tmp/inject.cjs",
        LD_PRELOAD: "/tmp/inject.so",
        BASH_ENV: "/tmp/inject.sh",
        ENV: "/tmp/inject.sh",
        NIX_CONFIG: "access-tokens = github.com=secret",
        PLATFORM_MASTER_KEY: "master-secret",
        platform_ai_api_key: "mixed-case-provider-secret",
        PLATFORM_AI_API_KEY: "provider-secret",
        PLATFORM_PUBLIC_URL: "https://dashboard.example.com",
      }),
    ).toEqual({
      HOME: "/home/example",
      LANG: "en_US.UTF-8",
      LC_CTYPE: "C.UTF-8",
      LOCALE_ARCHIVE: "/run/current-system/sw/lib/locale/locale-archive",
      NIX_REMOTE: "daemon",
      PATH: "/bin",
      SSL_CERT_FILE: "/etc/ssl/certs/ca-bundle.crt",
      TZDIR: "/etc/zoneinfo",
    });
  });

  it("applies application values before authoritative runtime values", () => {
    expect(
      buildWorkloadEnvironment(
        { HOME: "/host/home", PATH: "/host/bin", HOST_SECRET: "not-inherited" },
        { HOME: "/app/home", PATH: "/app/bin", APP_VALUE: "configured", PORT: "1111" },
        { APP_ID: "app-1", PORT: "4321" },
      ),
    ).toEqual({
      HOME: "/app/home",
      PATH: "/app/bin",
      APP_VALUE: "configured",
      APP_ID: "app-1",
      PORT: "4321",
    });
  });
});
