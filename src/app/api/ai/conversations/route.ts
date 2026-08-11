import type { NextRequest } from "next/server";
import { z } from "zod";
import { createConversation, listConversations } from "@/server/ai/conversation-store";
import { api, readJson } from "@/server/http";
import { requestActor } from "@/server/next-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z
  .object({
    scope: z
      .object({
        type: z.enum(["global", "app", "deployment", "integration", "ai"]),
        id: z.string().max(200).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export async function GET(request: NextRequest) {
  return api(request, () => listConversations(requestActor(request)));
}

export async function POST(request: NextRequest) {
  return api(request, async () => {
    const actor = requestActor(request);
    const input = createSchema.parse(await readJson(request, 4096));
    return createConversation(actor, input.scope ?? { type: "global" });
  });
}
