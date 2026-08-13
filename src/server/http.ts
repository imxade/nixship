import { type NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { errorMessage, HttpError } from "./errors.ts";
import { logger } from "./logger.ts";
import { requestOriginAllowed } from "./next-auth.ts";

export async function api<T>(
  request: NextRequest,
  handler: () => Promise<T> | T,
): Promise<NextResponse> {
  try {
    if (!(await requestOriginAllowed(request))) {
      throw new HttpError(403, "Cross-origin request rejected", "invalid_origin");
    }
    const result = await handler();
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    const validationError = error instanceof ZodError;
    const status = validationError ? 400 : error instanceof HttpError ? error.status : 500;
    const code = validationError
      ? "validation_error"
      : error instanceof HttpError
        ? error.code
        : "internal_error";
    const message = validationError
      ? (error.issues[0]?.message ?? "Request validation failed")
      : status >= 500
        ? "An internal error occurred"
        : errorMessage(error);
    if (status >= 500) {
      logger.error("API request failed", {
        error: errorMessage(error),
        path: request.nextUrl.pathname,
      });
    }
    const headers =
      error instanceof HttpError && error.retryAfterSeconds
        ? { "retry-after": String(error.retryAfterSeconds) }
        : undefined;
    return NextResponse.json({ ok: false, error: { code, message } }, { status, headers });
  }
}

export async function readJson(request: NextRequest, maxBytes = 64 * 1024): Promise<unknown> {
  const text = await readBoundedText(request, maxBytes);
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON", "invalid_json");
  }
}

export function isFormSubmission(request: NextRequest): boolean {
  return (
    request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/x-www-form-urlencoded") === true
  );
}

export async function readFormUrlEncoded(
  request: NextRequest,
  maxBytes = 64 * 1024,
): Promise<Record<string, string>> {
  if (!isFormSubmission(request)) {
    throw new HttpError(415, "Expected a URL-encoded form submission", "unsupported_media_type");
  }
  const text = await readBoundedText(request, maxBytes);

  const result: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(text)) {
    if (Object.hasOwn(result, key)) {
      throw new HttpError(
        400,
        `Form field "${key}" was submitted more than once`,
        "duplicate_field",
      );
    }
    result[key] = value;
  }
  return result;
}

export async function readBoundedText(request: NextRequest, maxBytes: number): Promise<string> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > maxBytes) {
    throw new HttpError(413, "Request body is too large", "body_too_large");
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, "Request body is too large", "body_too_large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}
