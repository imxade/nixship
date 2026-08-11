import type { NextRequest } from "next/server";
import { z } from "zod";
import { createAiReauthGrant } from "@/server/ai/reauth";
import { api, readJson } from "@/server/http";
import { requestActor } from "@/server/next-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ password: z.string().min(1).max(1024) }).strict();

export async function POST(request: NextRequest) {
  return api(request, async () => {
    const actor = requestActor(request);
    const input = schema.parse(await readJson(request, 2048));
    return createAiReauthGrant(actor, input.password);
  });
}
