import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireCurrentPassword, requireRole } from "@/server/auth";
import { api, readJson } from "@/server/http";
import { clientIp, requestUser } from "@/server/next-auth";
import { createUser, listUsers } from "@/server/user-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const mutationSchema = z.object({ currentPassword: z.string().min(1).max(256) }).passthrough();
export async function GET(request: NextRequest) {
  return api(request, () => {
    const user = requestUser(request);
    requireRole(user, ["owner", "admin"]);
    return listUsers();
  });
}
export async function POST(request: NextRequest) {
  return api(request, async () => {
    const user = requestUser(request);
    requireRole(user, ["owner", "admin"]);
    const input = mutationSchema.parse(await readJson(request));
    await requireCurrentPassword({ user, password: input.currentPassword, ip: clientIp(request) });
    return createUser(input, { id: user.id, ip: clientIp(request) });
  });
}
