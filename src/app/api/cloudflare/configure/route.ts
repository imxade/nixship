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
  accountId: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{32}$/i, "Enter a valid Cloudflare account ID"),
  apiToken: z.string().trim().min(10).max(1000),
  tunnelName: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9_-]+$/),
  dashboardHostname: z.string().trim().max(253).optional().default(""),
});

export async function POST(request: NextRequest) {
  return api(request, async () => {
    const user = requestUser(request);
    requireRole(user, ["owner", "admin"]);
    const input = schema.parse(await readJson(request));
    await (await getRuntime()).cloudflare.configure(input);
    audit({
      userId: user.id,
      ip: clientIp(request),
      action: "cloudflare.configured",
      details: {
        accountId: input.accountId,
        tunnelName: input.tunnelName,
        dashboardHostname: input.dashboardHostname,
      },
    });
    return (await getRuntime()).cloudflare.status();
  });
}
