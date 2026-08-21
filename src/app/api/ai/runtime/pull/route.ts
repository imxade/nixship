import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ensureManagedOllamaProfile } from "@/server/ai/provider-registry";
import { HttpError } from "@/server/errors";
import { requestActor, requestOriginAllowed } from "@/server/next-auth";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const pullSchema = z.object({
  model: z
    .string()
    .trim()
    .min(1)
    .max(301)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}(?::[A-Za-z0-9._-]{1,100})?$/, "Invalid model tag"),
});

export async function POST(request: NextRequest) {
  if (!(await requestOriginAllowed(request))) {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_origin", message: "Cross-origin request rejected" } },
      { status: 403 },
    );
  }
  const actor = requestActor(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_json", message: "Request body must be valid JSON" } },
      { status: 400 },
    );
  }

  const parsed = pullSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "validation_error",
          message: parsed.error.issues[0]?.message ?? "Invalid input",
        },
      },
      { status: 400 },
    );
  }
  const { model } = parsed.data;

  let ollama: Awaited<ReturnType<typeof getRuntime>>["ollama"];
  try {
    ollama = (await getRuntime()).ollama;
  } catch (error: unknown) {
    const status = error instanceof HttpError ? error.status : 500;
    const code = error instanceof HttpError ? error.code : "internal_error";
    const message = error instanceof HttpError ? error.message : "Runtime unavailable";
    return NextResponse.json({ ok: false, error: { code, message } }, { status });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown): void => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        const installed = await ollama.pullModel(model, (progress) => {
          send("progress", {
            status: progress.status,
            percent: progress.percent,
            completedBytes: progress.completedBytes,
            totalBytes: progress.totalBytes,
          });
        });
        const profile = ensureManagedOllamaProfile(model);
        send("done", {
          model: {
            name: installed.name,
            sizeBytes: installed.sizeBytes,
            parameterSize: installed.parameterSize,
            quantization: installed.quantization,
          },
          profile: {
            id: profile.id,
            modelId: profile.modelId,
            displayName: profile.displayName,
          },
          actor: actor.id,
        });
      } catch (error: unknown) {
        send("error", {
          message: error instanceof Error ? error.message : "Model download failed",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
