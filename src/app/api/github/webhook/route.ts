import crypto from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getApplicationsByRepositoryId, queueDeployment } from "@/server/app-service";
import { getDb, nowIso } from "@/server/db";
import { HttpError } from "@/server/errors";
import { events } from "@/server/events";
import { syncInstallations, webhookSecret } from "@/server/github";
import { readBoundedText } from "@/server/http";
import { logger } from "@/server/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;
const headersSchema = z.object({
  delivery: z.string().regex(/^[0-9a-f-]{1,100}$/i),
  event: z.string().regex(/^[a-z0-9_]{1,100}$/i),
  signature: z.string().regex(/^sha256=[0-9a-f]{64}$/i),
});
const payloadSchema = z
  .object({
    ref: z.string().max(1000).optional(),
    after: z
      .string()
      .regex(/^[0-9a-f]{40}$/i)
      .optional(),
    repository: z.object({ id: z.number().int().positive() }).optional(),
  })
  .passthrough();

export async function POST(request: NextRequest) {
  const parsedHeaders = headersSchema.safeParse({
    delivery: request.headers.get("x-github-delivery"),
    event: request.headers.get("x-github-event"),
    signature: request.headers.get("x-hub-signature-256"),
  });
  if (!parsedHeaders.success) {
    return NextResponse.json({ error: "Invalid GitHub webhook headers" }, { status: 400 });
  }
  const { delivery, event, signature } = parsedHeaders.data;
  let body: string;
  try {
    body = await readBoundedText(request, MAX_WEBHOOK_BYTES);
  } catch (error) {
    if (error instanceof HttpError && error.code === "body_too_large") {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }
    throw error;
  }

  let secret: string;
  try {
    secret = webhookSecret();
  } catch {
    return NextResponse.json({ error: "GitHub is not configured" }, { status: 409 });
  }
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
  const valid =
    signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!valid) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

  const db = getDb();
  const existing = db
    .prepare("SELECT status FROM webhook_deliveries WHERE delivery_id = ?")
    .get(delivery);
  if (existing) return NextResponse.json({ ok: true, duplicate: true });

  let payload: z.infer<typeof payloadSchema>;
  try {
    payload = payloadSchema.parse(JSON.parse(body));
  } catch {
    return NextResponse.json({ error: "Invalid webhook payload" }, { status: 400 });
  }
  const repositoryId = payload.repository?.id ?? null;
  const inserted = db
    .prepare(
      `INSERT OR IGNORE INTO webhook_deliveries(
        delivery_id, event_name, repository_id, received_at, status
      ) VALUES (?, ?, ?, ?, 'received')`,
    )
    .run(delivery, event, repositoryId, nowIso());
  if (inserted.changes === 0) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  try {
    if (["installation", "installation_repositories"].includes(event)) {
      void syncInstallations().catch((error) =>
        logger.warn("GitHub installation sync failed", { error: String(error) }),
      );
    } else if (event === "push" && repositoryId) {
      for (const app of getApplicationsByRepositoryId(repositoryId)) {
        if (!app.auto_deploy || app.desired_state !== "running") continue;
        const ref = String(payload.ref ?? "");
        if (ref === `refs/heads/${app.branch}`) {
          const sha = String(payload.after ?? "");
          if (sha && !/^0+$/.test(sha)) {
            const deployment = queueDeployment(app.id, {
              trigger: "github_push",
              commitSha: sha,
              requestedRef: sha,
            });
            events.publish("deployment.queued", `app:${app.id}`, {
              deploymentId: deployment.id,
              commit: sha,
              trigger: "github_push",
            });
          }
        }
      }
    }
    db.prepare(
      "UPDATE webhook_deliveries SET status = 'processed', processed_at = ? WHERE delivery_id = ?",
    ).run(nowIso(), delivery);
    return NextResponse.json({ ok: true });
  } catch (error) {
    db.prepare(
      "UPDATE webhook_deliveries SET status = 'failed', processed_at = ?, error = ? WHERE delivery_id = ?",
    ).run(nowIso(), error instanceof Error ? error.message : String(error), delivery);
    logger.error("GitHub webhook processing failed", { delivery, event, error: String(error) });
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}
