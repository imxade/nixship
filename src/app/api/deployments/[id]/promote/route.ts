import type { NextRequest } from "next/server";
import { requireRole } from "@/server/auth";
import { api } from "@/server/http";
import { clientIp, requestUser } from "@/server/next-auth";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
  return api(request, async () => {
    const user = requestUser(request);
    requireRole(user, ["owner", "admin", "operator"]);
    const { id } = await context.params;
    const runtimeInstance = await getRuntime();
    await runtimeInstance.promoteDeployment(id, { id: user.id, ip: clientIp(request) });
    return { promoted: true };
  });
}
