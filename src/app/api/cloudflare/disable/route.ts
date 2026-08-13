import type { NextRequest } from "next/server";
import { z } from "zod";
import { audit } from "@/server/audit";
import { requireCurrentPassword, requireRole } from "@/server/auth";
import { api, readJson } from "@/server/http";
import { clientIp, requestUser } from "@/server/next-auth";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ currentPassword: z.string().min(1).max(256) }).strict();

export async function POST(request: NextRequest) {
  return api(request, async () => {
    const user = requestUser(request);
    requireRole(user, ["owner", "admin"]);
    const input = schema.parse(await readJson(request, 1024));
    await requireCurrentPassword({ user, password: input.currentPassword, ip: clientIp(request) });
    const runtime = await getRuntime();
    await runtime.cloudflare.disable();
    audit({ userId: user.id, ip: clientIp(request), action: "cloudflare.disabled" });
    return runtime.cloudflare.status();
  });
}
