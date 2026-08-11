import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { aiCapabilities } from "@/server/ai/capabilities";
import { approveAndExecutePlan } from "@/server/ai/plans/executor";
import { api, readJson } from "@/server/http";
import { requestActor } from "@/server/next-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const approvalSchema = z
  .object({
    planHash: z.string().length(64),
    destructiveConfirmation: z.string().max(100).optional(),
  })
  .strict();

export async function POST(request: NextRequest, context: Context) {
  return api(request, async () => {
    const actor = requestActor(request);
    const { planHash, destructiveConfirmation } = approvalSchema.parse(
      await readJson(request, 1024),
    );
    return approveAndExecutePlan({
      planId: (await context.params).id,
      planHash,
      destructiveConfirmation,
      actor,
      requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
      registry: aiCapabilities(),
      background: true,
    });
  });
}
