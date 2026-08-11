import type { NextRequest } from "next/server";
import { deleteAiSecretReference } from "@/server/ai/secrets";
import { api } from "@/server/http";
import { requestActor } from "@/server/next-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function DELETE(request: NextRequest, context: Context) {
  return api(request, async () => {
    deleteAiSecretReference((await context.params).id, requestActor(request));
    return {};
  });
}
