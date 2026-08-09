import type { NextRequest } from "next/server";
import { z } from "zod";
import { audit } from "@/server/audit";
import { requireRole } from "@/server/auth";
import { api, readJson } from "@/server/http";
import { clientIp, requestUser } from "@/server/next-auth";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  hostname: z.string().trim().max(253).optional().default(""),
});

export async function PUT(request: NextRequest) {
  return api(request, async () => {
    const user = requestUser(request);
    requireRole(user, ["owner", "admin"]);
    const input = schema.parse(await readJson(request));
    const runtime = await getRuntime();
    await runtime.cloudflare.setDashboardHostname(input.hostname);
    audit({
      userId: user.id,
      ip: clientIp(request),
      action: "cloudflare.dashboard_hostname.updated",
      details: { hostname: input.hostname },
    });
    return runtime.cloudflare.status();
  });
}
