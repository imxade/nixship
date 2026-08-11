import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  aiSecretKindSchema,
  aiSecretScopeSchema,
  createAiSecretReference,
} from "@/server/ai/secrets";
import { api, readJson } from "@/server/http";
import { requestActor } from "@/server/next-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z
  .object({
    kind: aiSecretKindSchema,
    scope: aiSecretScopeSchema,
    value: z
      .string()
      .min(1)
      .max(64 * 1024),
  })
  .strict();

export async function POST(request: NextRequest) {
  return api(request, async () => {
    const actor = requestActor(request);
    const input = schema.parse(await readJson(request, 68 * 1024));
    return createAiSecretReference({ actor, ...input });
  });
}
