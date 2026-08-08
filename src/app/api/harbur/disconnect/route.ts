import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/server/auth";
import { disconnectHarbur } from "@/server/harbur";
import { api, readJson } from "@/server/http";
import { clientIp, requestUser } from "@/server/next-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ connectionId: z.string().uuid() });

export async function POST(request: NextRequest) {
  return api(request, async () => {
    const user = requestUser(request);
    requireRole(user, ["owner", "admin"]);
    const { connectionId } = schema.parse(await readJson(request));
    disconnectHarbur(connectionId, { id: user.id, ip: clientIp(request) });
    return { disconnected: true };
  });
}
