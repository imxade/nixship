import type { NextRequest } from "next/server";
import { audit } from "@/server/audit";
import { requireRole } from "@/server/auth";
import { api } from "@/server/http";
import { clientIp, requestUser } from "@/server/next-auth";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return api(request, async () => {
    const user = requestUser(request);
    requireRole(user, ["owner", "admin"]);
    const runtime = await getRuntime();
    await runtime.cloudflare.disable();
    audit({ userId: user.id, ip: clientIp(request), action: "cloudflare.disabled" });
    return runtime.cloudflare.status();
  });
}
