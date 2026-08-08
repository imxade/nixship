import { describe, expect, it } from "vitest";
import { applicationAccessLinks } from "../../src/server/access-links.ts";

describe("application access links", () => {
  const quickTunnel = {
    key: "deployment:release-one",
    targetType: "deployment" as const,
    appId: "one",
    appName: "Example",
    deploymentId: "release-one",
    commitSha: "abc123",
    localPort: 4100,
    url: "https://temporary.trycloudflare.com",
    status: "running" as const,
    running: true,
    lastError: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("keeps temporary and custom routes together", () => {
    const links = applicationAccessLinks({
      publicPort: 4100,
      applicationStatus: "running",
      quickTunnel,
      customRoutes: [
        {
          hostname: "app.example.com",
          appId: "one",
          appName: "Example",
          publicPort: 4100,
          zoneId: "zone",
          status: "managed",
          lastError: null,
          lastSyncedAt: new Date().toISOString(),
        },
      ],
      namedTunnelEnabled: true,
      namedTunnelRunning: true,
    });

    expect(links.some((link) => link.kind === "temporary" && link.status === "available")).toBe(
      true,
    );
    expect(links.some((link) => link.url === "https://app.example.com")).toBe(true);
  });

  it("does not report a failed application as available", () => {
    const links = applicationAccessLinks({
      publicPort: 4100,
      applicationStatus: "failed",
      quickTunnel,
      customRoutes: [],
      namedTunnelEnabled: false,
      namedTunnelRunning: false,
    });

    expect(links.every((link) => link.status === "unavailable")).toBe(true);
  });

  it("does not invent a temporary URL while the tunnel is starting or failed", () => {
    for (const status of ["starting", "error"] as const) {
      const links = applicationAccessLinks({
        publicPort: 4100,
        applicationStatus: "running",
        quickTunnel: {
          ...quickTunnel,
          url: null,
          running: false,
          status,
          lastError: status === "error" ? "cloudflared was not found" : null,
        },
        customRoutes: [],
        namedTunnelEnabled: false,
        namedTunnelRunning: false,
      });

      expect(links.some((link) => link.kind === "temporary")).toBe(false);
    }
  });
});
