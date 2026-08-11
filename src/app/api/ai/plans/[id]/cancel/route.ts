import type { NextRequest } from "next/server";
import { z } from "zod";
import { cancelPlan } from "@/server/ai/plans/store";
import { api, readJson } from "@/server/http";
import { requestActor } from "@/server/next-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const cancellationSchema = z.object({ planHash: z.string().length(64) }).strict();

export async function POST(request: NextRequest, context: Context) {
  return api(request, async () => {
    const actor = requestActor(request);
    const { planHash } = cancellationSchema.parse(await readJson(request, 1024));
    return cancelPlan((await context.params).id, planHash, actor);
  });
}
