import type { NextRequest } from "next/server";
import { z } from "zod";
import { normalizeDomain } from "@/server/app-service";
import { audit } from "@/server/audit";
import { requireCurrentPassword, requireRole } from "@/server/auth";
import { confirmDomainZoneInventory } from "@/server/cloudflare-zones";
import { api, readJson } from "@/server/http";
import { clientIp, requestUser } from "@/server/next-auth";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ apex: string }> };
const schema = z.object({ currentPassword: z.string().min(1).max(256) }).strict();

export async function POST(request: NextRequest, context: Context) {
  return api(request, async () => {
    const user = requestUser(request);
    requireRole(user, ["owner", "admin"]);
    const input = schema.parse(await readJson(request, 1024));
    await requireCurrentPassword({ user, password: input.currentPassword, ip: clientIp(request) });
    const apex = normalizeDomain((await context.params).apex);
    confirmDomainZoneInventory(apex);
    const runtimeInstance = await getRuntime();
    await runtimeInstance.cloudflare.syncIngress();
    audit({
      userId: user.id,
      ip: clientIp(request),
      action: "cloudflare.zone_inventory_confirmed",
      entityType: "domain_zone",
      entityId: apex,
    });
    return runtimeInstance.cloudflare.status();
  });
}
