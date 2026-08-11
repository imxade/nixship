import crypto from "node:crypto";
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ZodError, z } from "zod";
import { type PlannerOutcome, runPlanner } from "@/server/ai/planner";
import { HttpError } from "@/server/errors";
import { readJson } from "@/server/http";
import { requestActor, requestOriginAllowed } from "@/server/next-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const chatSchema = z
  .object({
    conversationId: z.string().uuid(),
    text: z
      .string()
      .trim()
      .min(1)
      .max(16 * 1024),
  })
  .strict();

type NixShipUiMessage = UIMessage<unknown, { outcome: PlannerOutcome }>;

export async function POST(request: NextRequest): Promise<Response> {
  try {
    if (!(await requestOriginAllowed(request))) {
      throw new HttpError(403, "Cross-origin request rejected", "invalid_origin");
    }
    const actor = requestActor(request);
    const input = chatSchema.parse(await readJson(request, 20 * 1024));
    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
    const stream = createUIMessageStream<NixShipUiMessage>({
      execute: async ({ writer }) => {
        writer.write({
          type: "data-outcome",
          id: requestId,
          data: { type: "answer", content: "Inspecting current Nix Ship state…" },
          transient: true,
        });
        const outcome = await runPlanner({ ...input, actor, requestId });
        const text =
          outcome.type === "answer" || outcome.type === "plan" ? outcome.content : outcome.prompt;
        const textId = crypto.randomUUID();
        writer.write({ type: "text-start", id: textId });
        writer.write({ type: "text-delta", id: textId, delta: text });
        writer.write({ type: "text-end", id: textId });
        writer.write({ type: "data-outcome", id: requestId, data: outcome });
      },
      onError: safeStreamError,
    });
    return createUIMessageStreamResponse({ stream });
  } catch (error) {
    const validation = error instanceof ZodError;
    const status = validation ? 400 : error instanceof HttpError ? error.status : 500;
    const code = validation
      ? "validation_error"
      : error instanceof HttpError
        ? error.code
        : "internal_error";
    const message = validation
      ? (error.issues[0]?.message ?? "Request validation failed")
      : safeStreamError(error);
    return NextResponse.json({ error: message, code }, { status });
  }
}

function safeStreamError(error: unknown): string {
  if (error instanceof HttpError) {
    if (error.status < 500 || error.code.startsWith("ai_") || error.code.startsWith("model_")) {
      return error.message;
    }
  }
  return "The assistant request failed";
}
