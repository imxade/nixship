import { describe, expect, it } from "vitest";
import { workloadBaseEnvironment } from "../../src/server/process-supervisor.ts";

describe("workload environment boundary", () => {
  it("does not inherit control-plane secrets or settings", () => {
    expect(
      workloadBaseEnvironment({
        PATH: "/bin",
        HOME: "/home/example",
        PLATFORM_MASTER_KEY: "master-secret",
        PLATFORM_AI_API_KEY: "provider-secret",
        PLATFORM_PUBLIC_URL: "https://dashboard.example.com",
      }),
    ).toEqual({ PATH: "/bin", HOME: "/home/example" });
  });
});
