import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  assertManagedOllamaModelRemovable,
  removeManagedOllamaProfile,
} from "@/server/ai/provider-registry";
import { api, readJson } from "@/server/http";
import { requestActor } from "@/server/next-auth";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const removeSchema = z.object({
  model: z
    .string()
    .trim()
    .min(1)
    .max(301)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}(?::[A-Za-z0-9._-]{1,100})?$/, "Invalid model tag"),
});

export async function POST(request: NextRequest) {
  return api(request, async () => {
    requestActor(request);
    const body = await readJson(request);
    const { model } = removeSchema.parse(body);
    assertManagedOllamaModelRemovable(model);
    const ollama = (await getRuntime()).ollama;
    await ollama.removeModel(model);
    removeManagedOllamaProfile(model);
    return { removed: model };
  });
}
