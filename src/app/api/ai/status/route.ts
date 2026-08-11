import type { NextRequest } from "next/server";
import { aiProviderStatus } from "@/server/ai/provider";
import { api } from "@/server/http";
import { requestActor } from "@/server/next-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return api(request, () => {
    requestActor(request);
    return aiProviderStatus();
  });
}
