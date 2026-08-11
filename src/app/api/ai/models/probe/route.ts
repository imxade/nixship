import type { NextRequest } from "next/server";
import { z } from "zod";
import { probeActionPlanner } from "@/server/ai/model-probe";
import { configuredAiProvider } from "@/server/ai/provider";
import { probeAiModelProfile } from "@/server/ai/provider-registry";
import { requireRole } from "@/server/auth";
import { api, readJson } from "@/server/http";
import { requestActor } from "@/server/next-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ profileId: z.string().uuid().nullable().default(null) }).strict();

export async function POST(request: NextRequest) {
  return api(request, async () => {
    const actor = requestActor(request);
    requireRole(actor, ["owner", "admin"]);
    const input = schema.parse(await readJson(request, 1024));
    return input.profileId
      ? probeAiModelProfile(actor, input.profileId)
      : probeActionPlanner(configuredAiProvider());
  });
}
