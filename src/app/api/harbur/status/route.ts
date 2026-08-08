import type { NextRequest } from "next/server";
import { listHarburConnections } from "@/server/harbur";
import { api } from "@/server/http";
import { requestUser } from "@/server/next-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return api(request, () => {
    requestUser(request);
    return { connections: listHarburConnections() };
  });
}
