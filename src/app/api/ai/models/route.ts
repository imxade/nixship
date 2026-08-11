import type { NextRequest } from "next/server";
import { listAiProviders } from "@/server/ai/provider-registry";
import { api } from "@/server/http";
import { requestActor } from "@/server/next-auth";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return api(request, async () => {
    requestActor(request);
    const runtime = (await getRuntime()).ollama;
    return {
      runtime: runtime.status(),
      resourcePreflight: runtime.resourcePreflight(),
      local: await runtime.listModels(),
      providers: listAiProviders(),
      curated: [
        {
          modelId: "qwen2.5:7b",
          displayName: "Qwen 2.5 7B",
          approximateSizeBytes: 4_700_000_000,
          resourceClass: "medium",
        },
        {
          modelId: "qwen2.5:3b",
          displayName: "Qwen 2.5 3B",
          approximateSizeBytes: 1_900_000_000,
          resourceClass: "small",
        },
        {
          modelId: "granite3.3:2b",
          displayName: "Granite 3.3 2B",
          approximateSizeBytes: 1_500_000_000,
          resourceClass: "small",
        },
      ],
    };
  });
}
