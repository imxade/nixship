import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  deleteConversation,
  getConversation,
  listMessages,
  setConversationModel,
} from "@/server/ai/conversation-store";
import { api, readJson } from "@/server/http";
import { requestActor } from "@/server/next-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const updateSchema = z.object({ modelProfileId: z.string().uuid().nullable() }).strict();

export async function GET(request: NextRequest, context: Context) {
  return api(request, async () => {
    const actor = requestActor(request);
    const { id } = await context.params;
    return { conversation: getConversation(id, actor), messages: listMessages(id, actor) };
  });
}

export async function PATCH(request: NextRequest, context: Context) {
  return api(request, async () => {
    const actor = requestActor(request);
    const input = updateSchema.parse(await readJson(request, 1024));
    return setConversationModel((await context.params).id, actor, input.modelProfileId);
  });
}

export async function DELETE(request: NextRequest, context: Context) {
  return api(request, async () => {
    const actor = requestActor(request);
    const { id } = await context.params;
    deleteConversation(id, actor);
    return {};
  });
}
