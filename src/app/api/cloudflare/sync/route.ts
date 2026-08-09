import type { NextRequest } from "next/server";
import { requireRole } from "@/server/auth";
import { api } from "@/server/http";
import { requestUser } from "@/server/next-auth";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return api(request, async () => {
    const user = requestUser(request);
    requireRole(user, ["owner", "admin"]);
    const runtime = await getRuntime();
    await runtime.cloudflare.syncIngress();
    return runtime.cloudflare.status();
  });
}
