import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { runPlanner } from "@/server/ai/planner";
import { api, readJson } from "@/server/http";
import { requestActor } from "@/server/next-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const chatSchema = z
  .object({
    conversationId: z.string().uuid(),
    text: z
      .string()
      .trim()
      .min(1)
      .max(16 * 1024),
  })
  .strict();

export async function POST(request: NextRequest) {
  return api(request, async () => {
    const actor = requestActor(request);
    const input = chatSchema.parse(await readJson(request, 20 * 1024));
    return runPlanner({
      ...input,
      actor,
      requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
    });
  });
}
