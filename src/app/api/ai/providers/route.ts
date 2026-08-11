import type { NextRequest } from "next/server";
import {
  configureAiProvider,
  configureProviderSchema,
  listAiProviders,
} from "@/server/ai/provider-registry";
import { assertFreshAiReauth } from "@/server/ai/reauth";
import { requireRole } from "@/server/auth";
import { api, readJson } from "@/server/http";
import { requestActor } from "@/server/next-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return api(request, () => {
    requestActor(request);
    return { providers: listAiProviders() };
  });
}

export async function POST(request: NextRequest) {
  return api(request, async () => {
    const actor = requestActor(request);
    requireRole(actor, ["owner", "admin"]);
    assertFreshAiReauth(actor);
    const input = configureProviderSchema.parse(await readJson(request, 32 * 1024));
    return configureAiProvider(actor, input);
  });
}
