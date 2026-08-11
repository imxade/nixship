import type { NextRequest } from "next/server";
import { z } from "zod";
import { removeAiProvider } from "@/server/ai/provider-registry";
import { assertFreshAiReauth } from "@/server/ai/reauth";
import { requireRole } from "@/server/auth";
import { HttpError } from "@/server/errors";
import { api, readJson } from "@/server/http";
import { requestActor } from "@/server/next-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const confirmationSchema = z.object({ confirmation: z.string().max(200) }).strict();

export async function DELETE(request: NextRequest, context: Context) {
  return api(request, async () => {
    const actor = requestActor(request);
    requireRole(actor, ["owner", "admin"]);
    assertFreshAiReauth(actor);
    const providerId = (await context.params).id;
    const input = confirmationSchema.parse(await readJson(request, 1024));
    if (input.confirmation !== `DELETE ${providerId}`) {
      throw new HttpError(
        409,
        "Type the exact provider deletion confirmation",
        "confirmation_required",
      );
    }
    removeAiProvider(actor, providerId);
    return { removedProviderId: providerId };
  });
}
