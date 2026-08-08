import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/server/auth";
import {
  activeDeploymentLimit,
  MAX_ACTIVE_DEPLOYMENT_LIMIT,
  updateActiveDeploymentLimit,
} from "@/server/deployment-settings";
import { api, readJson } from "@/server/http";
import { clientIp, requestUser } from "@/server/next-auth";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateSchema = z.object({
  activeDeploymentLimit: z.coerce.number().int().min(1).max(MAX_ACTIVE_DEPLOYMENT_LIMIT),
});

export async function GET(request: NextRequest) {
  return api(request, () => {
    requestUser(request);
    return { activeDeploymentLimit: activeDeploymentLimit() };
  });
}

export async function PATCH(request: NextRequest) {
  return api(request, async () => {
    const user = requestUser(request);
    requireRole(user, ["owner", "admin"]);
    const input = updateSchema.parse(await readJson(request));
    const value = updateActiveDeploymentLimit(input.activeDeploymentLimit, {
      id: user.id,
      ip: clientIp(request),
    });
    const runtimeInstance = await getRuntime();
    await runtimeInstance.deployments.enforceActiveDeploymentLimits();
    return { activeDeploymentLimit: value };
  });
}
