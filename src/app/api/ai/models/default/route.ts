import type { NextRequest } from "next/server";
import { z } from "zod";
import { setAiModelDefault } from "@/server/ai/provider-registry";
import { requireRole } from "@/server/auth";
import { api, readJson } from "@/server/http";
import { requestActor } from "@/server/next-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const defaultModelSchema = z
  .object({
    profileId: z.string().uuid(),
    purpose: z.enum(["conversation", "action_planner"]),
  })
  .strict();

export async function POST(request: NextRequest) {
  return api(request, async () => {
    const actor = requestActor(request);
    requireRole(actor, ["owner", "admin"]);
    const input = defaultModelSchema.parse(await readJson(request, 1024));
    return setAiModelDefault(actor, input.profileId, input.purpose);
  });
}
