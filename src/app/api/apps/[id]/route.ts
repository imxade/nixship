import type { NextRequest } from "next/server";
import { applicationAccessLinks } from "@/server/access-links";
import {
  applicationDomains,
  deleteApplication,
  environmentKeys,
  getApplication,
  listDeployments,
  updateApplication,
} from "@/server/app-service";
import { requireRole } from "@/server/auth";
import { api, readJson } from "@/server/http";
import { latestAppMetric } from "@/server/metrics";
import { clientIp, requestUser } from "@/server/next-auth";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context) {
  return api(request, async () => {
    requestUser(request);
    const { id } = await context.params;
    const runtimeInstance = await getRuntime();
    const app = getApplication(id);
    const cloudflare = runtimeInstance.cloudflare.status();
    const routes = cloudflare.routes.filter((route) => route.appId === id);
    const deployments = listDeployments(id, 30);
    const quickTunnelByDeployment = new Map(
      runtimeInstance.quickTunnels
        .applicationRoutes(id)
        .filter((route) => route.deploymentId)
        .map((route) => [route.deploymentId, route]),
    );
    const quickTunnel = app.active_deployment_id
      ? (quickTunnelByDeployment.get(app.active_deployment_id) ?? null)
      : null;
    const operationalStatus = runtimeInstance.applicationOperationalStatus(id);
    return {
      app,
      operationalStatus,
      domains: applicationDomains(id),
      cloudflare: {
        configured: cloudflare.configured,
        enabled: cloudflare.enabled,
        running: cloudflare.running,
        routes,
      },
      quickTunnel,
      accessLinks: applicationAccessLinks({
        publicPort: app.public_port,
        applicationStatus: operationalStatus,
        quickTunnel,
        customRoutes: routes,
        namedTunnelEnabled: cloudflare.enabled,
        namedTunnelRunning: cloudflare.running,
      }),
      environment: environmentKeys(id),
      deployments: deployments.map((deployment) => ({
        ...deployment,
        isProduction: deployment.id === app.active_deployment_id,
        quickTunnel: quickTunnelByDeployment.get(deployment.id) ?? null,
      })),
      metric: latestAppMetric(id),
    };
  });
}

export async function PATCH(request: NextRequest, context: Context) {
  return api(request, async () => {
    const user = requestUser(request);
    requireRole(user, ["owner", "admin", "operator"]);
    const { id } = await context.params;
    const app = updateApplication(id, await readJson(request), {
      id: user.id,
      ip: clientIp(request),
    });
    const runtimeInstance = await getRuntime();
    await runtimeInstance.proxy.reconcile();
    await runtimeInstance.cloudflare.syncIngress();
    await runtimeInstance.quickTunnels.reconcile();
    return app;
  });
}

export async function DELETE(request: NextRequest, context: Context) {
  return api(request, async () => {
    const user = requestUser(request);
    requireRole(user, ["owner", "admin"]);
    const { id } = await context.params;
    const runtimeInstance = await getRuntime();
    await runtimeInstance.stopApplication(id);
    await runtimeInstance.quickTunnels.removeApplication(id);
    deleteApplication(id);
    await runtimeInstance.proxy.reconcile();
    await runtimeInstance.cloudflare.syncIngress();
    await runtimeInstance.quickTunnels.reconcile();
    return {};
  });
}
