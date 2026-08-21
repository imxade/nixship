import type { NextRequest } from "next/server";
import { AI_PROVIDER_PRESETS } from "@/server/ai/provider-catalog";
import { listAiProviders } from "@/server/ai/provider-registry";
import { api } from "@/server/http";
import { requestActor } from "@/server/next-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return api(request, () => {
    requestActor(request);
    return {
      providers: listAiProviders(),
      presets: AI_PROVIDER_PRESETS,
    };
  });
}
