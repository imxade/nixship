import type { NextRequest } from "next/server";
import { getRun } from "@/server/ai/plans/executor";
import { api } from "@/server/http";
import { requestActor } from "@/server/next-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context) {
  return api(request, async () => getRun((await context.params).id, requestActor(request)));
}
