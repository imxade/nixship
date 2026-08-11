import type { NextRequest } from "next/server";
import { api } from "@/server/http";
import { requestActor } from "@/server/next-auth";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return api(request, async () => {
    requestActor(request);
    const runtime = (await getRuntime()).ollama;
    return { ...runtime.status(), resourcePreflight: runtime.resourcePreflight() };
  });
}
