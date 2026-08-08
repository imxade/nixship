import type { NextRequest } from "next/server";
import { applicationAccessLinks } from "@/server/access-links";
import {
  applicationDomains,
  createApplication,
  listApplications,
  queueDeployment,
} from "@/server/app-service";
import { requireRole } from "@/server/auth";
import { events } from "@/server/events";
import { latestHarburRevision } from "@/server/harbur";
import { api, readJson } from "@/server/http";
import { clientIp, requestUser } from "@/server/next-auth";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return api(request, async () => {
    requestUser(request);
    const runtime = await getRuntime();
    const cloudflare = runtime.cloudflare.status();
    const quickTunnelByDeployment = new Map(
      runtime.quickTunnels
        .status()
        .routes.filter((route) => route.deploymentId)
        .map((route) => [route.deploymentId, route]),
    );
    return listApplications().map((app) => {
      const domains = applicationDomains(app.id);
      const routes = cloudflare.routes.filter((route) => route.appId === app.id);
      const quickTunnel = app.active_deployment_id
        ? (quickTunnelByDeployment.get(app.active_deployment_id) ?? null)
        : null;
      const operationalStatus = runtime.applicationOperationalStatus(app.id);
      return {
        ...app,
        operationalStatus,
        domains,
        domain: domains[0] ?? null,
        accessLinks: applicationAccessLinks({
          publicPort: app.public_port,
          applicationStatus: operationalStatus,
          quickTunnel,
          customRoutes: routes,
          namedTunnelEnabled: cloudflare.enabled,
          namedTunnelRunning: cloudflare.running,
        }),
      };
    });
  });
}

export async function POST(request: NextRequest) {
  return api(request, async () => {
    const user = requestUser(request);
    requireRole(user, ["owner", "admin", "operator"]);
    const app = await createApplication(await readJson(request), {
      id: user.id,
      ip: clientIp(request),
    });
    const runtimeInstance = await getRuntime();
    await runtimeInstance.proxy.reconcile();
    await runtimeInstance.quickTunnels.reconcile();
    const revision = app.source_provider === "harbur" ? await latestHarburRevision(app) : null;
    const deployment = queueDeployment(app.id, {
      trigger: "manual",
      commitSha: revision,
      requestedRef: revision ?? undefined,
    });
    events.publish("deployment.queued", `app:${app.id}`, {
      deploymentId: deployment.id,
      trigger: "manual",
    });
    return app;
  });
}
