import type { NextRequest } from "next/server";
import { z } from "zod";
import { type AiSettings, getAiSettings, updateAiSettings } from "@/server/ai/ai-settings";
import { requireRole } from "@/server/auth";
import { api, readJson } from "@/server/http";
import { clientIp, requestUser } from "@/server/next-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateSchema = z
  .object({
    maxModelSteps: z.coerce.number().int().min(2).max(12).optional(),
    maxSimultaneousReads: z.coerce.number().int().min(1).max(8).optional(),
    maxPendingPlanners: z.coerce.number().int().min(1).max(16).optional(),
    readToolsLimit: z.coerce.number().int().min(5).max(40).optional(),
    capabilitySearchLimit: z.coerce.number().int().min(4).max(32).optional(),
    conversationHistoryLimit: z.coerce.number().int().min(5).max(50).optional(),
    planExpiryMinutes: z.coerce.number().int().min(5).max(30).optional(),
    maxPlanLifetimeMinutes: z.coerce.number().int().min(10).max(60).optional(),
    resourceLockTtlMinutes: z.coerce.number().int().min(5).max(30).optional(),
    lockRenewalSeconds: z.coerce.number().int().min(30).max(300).optional(),
    reauthTtlMinutes: z.coerce.number().int().min(2).max(15).optional(),
    secretRefTtlMinutes: z.coerce.number().int().min(5).max(60).optional(),
    maxChatInputBytes: z.coerce.number().int().min(4096).max(65536).optional(),
    maxMessageBytes: z.coerce.number().int().min(16384).max(131072).optional(),
    providerResponseMaxBytes: z.coerce.number().int().min(262144).max(4194304).optional(),
  })
  .strict();

export async function GET(request: NextRequest) {
  return api(request, (): AiSettings => {
    requestUser(request);
    return getAiSettings();
  });
}

export async function PATCH(request: NextRequest) {
  return api(request, async (): Promise<AiSettings> => {
    const user = requestUser(request);
    requireRole(user, ["owner", "admin"]);
    const input = updateSchema.parse(await readJson(request));
    return updateAiSettings(input, { id: user.id, ip: clientIp(request) });
  });
}
