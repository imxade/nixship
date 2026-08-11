import type { NextRequest } from "next/server";
import { getPlan } from "@/server/ai/plans/store";
import { api } from "@/server/http";
import { requestActor } from "@/server/next-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context) {
  return api(request, async () => {
    const actor = requestActor(request);
    return getPlan((await context.params).id, actor);
  });
}
