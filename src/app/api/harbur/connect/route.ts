import type { NextRequest } from "next/server";
import { requireRole } from "@/server/auth";
import { connectHarbur } from "@/server/harbur";
import { api, readJson } from "@/server/http";
import { clientIp, requestUser } from "@/server/next-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return api(request, async () => {
    const user = requestUser(request);
    requireRole(user, ["owner", "admin"]);
    return connectHarbur(await readJson(request), { id: user.id, ip: clientIp(request) });
  });
}
