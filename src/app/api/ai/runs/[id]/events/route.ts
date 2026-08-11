import type { NextRequest } from "next/server";
import { getRun } from "@/server/ai/plans/executor";
import { events, type PlatformEvent } from "@/server/events";
import { requestActor } from "@/server/next-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context): Promise<Response> {
  let runId: string;
  try {
    runId = (await context.params).id;
    getRun(runId, requestActor(request));
  } catch {
    return Response.json(
      { ok: false, error: { code: "run_not_found", message: "AI run not found" } },
      { status: 404 },
    );
  }
  const lastId = Number(
    request.headers.get("last-event-id") ?? request.nextUrl.searchParams.get("lastEventId") ?? 0,
  );
  const scope = `ai-run:${runId}`;
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  const serialize = (event: PlatformEvent) =>
    encoder.encode(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events.since(Number.isFinite(lastId) ? lastId : 0, scope))
        controller.enqueue(serialize(event));
      unsubscribe = events.subscribe((event) => {
        if (event.scope === scope) controller.enqueue(serialize(event));
      });
      heartbeat = setInterval(
        () => controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`)),
        15_000,
      );
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
