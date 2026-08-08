import type { NextRequest } from "next/server";
import { z } from "zod";
import { listHarburRepositories } from "@/server/harbur";
import { api } from "@/server/http";
import { requestUser } from "@/server/next-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({ connectionId: z.string().uuid() });

export async function GET(request: NextRequest) {
  return api(request, async () => {
    requestUser(request);
    const { connectionId } = querySchema.parse({
      connectionId: request.nextUrl.searchParams.get("connectionId"),
    });
    return listHarburRepositories(connectionId);
  });
}
