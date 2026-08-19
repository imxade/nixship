import { audit } from "../audit.ts";
import { type AuthenticatedActor, verifyCurrentPassword } from "../auth.ts";
import { getDb, nowIso } from "../db.ts";
import { HttpError } from "../errors.ts";
import { aiReauthTtlMs } from "./ai-settings.ts";

export async function createAiReauthGrant(
  actor: AuthenticatedActor,
  password: string,
  ip?: string | null,
): Promise<{ expiresAt: string }> {
  if (!(await verifyCurrentPassword({ userId: actor.id, password, ip }))) {
    audit({
      userId: actor.id,
      action: "ai.reauth_failed",
      entityType: "session",
      entityId: actor.sessionId,
      ip,
    });
    throw new HttpError(401, "Current password is incorrect", "reauth_failed");
  }
  const now = nowIso();
  const expiresAt = new Date(Date.now() + aiReauthTtlMs()).toISOString();
  getDb()
    .prepare(
      `INSERT INTO ai_reauth_grants(session_id, user_id, verified_at, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         user_id = excluded.user_id,
         verified_at = excluded.verified_at,
         expires_at = excluded.expires_at`,
    )
    .run(actor.sessionId, actor.id, now, expiresAt);
  audit({
    userId: actor.id,
    action: "ai.reauthenticated",
    entityType: "session",
    entityId: actor.sessionId,
    ip,
  });
  return { expiresAt };
}

export function assertFreshAiReauth(actor: AuthenticatedActor): void {
  const row = getDb()
    .prepare(
      "SELECT 1 FROM ai_reauth_grants WHERE session_id = ? AND user_id = ? AND expires_at > ?",
    )
    .get(actor.sessionId, actor.id, nowIso());
  if (!row) {
    throw new HttpError(
      401,
      "Re-enter your current password before approving this sensitive plan",
      "fresh_reauth_required",
    );
  }
}
