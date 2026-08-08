import os from "node:os";
import type { NextRequest } from "next/server";
import { dashboardAccessLinks } from "@/server/access-links";
import { config } from "@/server/config";
import { activeDeploymentLimit } from "@/server/deployment-settings";
import { currentNixSystem } from "@/server/flake";
import { getGitHubApp } from "@/server/github";
import { api } from "@/server/http";
import { latestHostMetric } from "@/server/metrics";
import { requestUser } from "@/server/next-auth";
import { preferredPublicDashboardRoute } from "@/server/public-origin";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return api(request, async () => {
    requestUser(request);
    const runtimeInstance = await getRuntime();
    let nixSystem: string | null = null;
    try {
      nixSystem = await currentNixSystem();
    } catch {}
    const cloudflare = runtimeInstance.cloudflare.status();
    const quickTunnels = runtimeInstance.quickTunnels.status();
    const dashboardQuick =
      quickTunnels.routes.find((route) => route.targetType === "dashboard") ?? null;
    return {
      host: {
        hostname: os.hostname(),
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
        nixSystem,
      },
      metric: latestHostMetric(),
      settings: { activeDeploymentLimit: activeDeploymentLimit() },
      github: {
        connected: Boolean(getGitHubApp()),
        webhookRoute: preferredPublicDashboardRoute(),
        reconciliationSeconds: config.SOURCE_POLL_SECONDS,
      },
      cloudflare,
      quickTunnels,
      accessLinks: dashboardAccessLinks({
        port: config.PORT,
        quickTunnel: dashboardQuick,
        customHostname: cloudflare.dashboardHostname,
        namedTunnelEnabled: cloudflare.enabled,
        namedTunnelRunning: cloudflare.running,
      }),
    };
  });
}
