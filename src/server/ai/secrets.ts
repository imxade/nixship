import { z } from "zod";
import type { AuthenticatedActor } from "../auth.ts";
import { decryptSecret, encryptSecret, randomToken } from "../crypto.ts";
import { getDb, nowIso } from "../db.ts";
import { HttpError } from "../errors.ts";
import { aiSecretRefTtlMs } from "./ai-settings.ts";

export const aiSecretKindSchema = z.enum([
  "cloudflare_api_token",
  "harbur_token",
  "provider_api_key",
  "dotenv",
  "user_password",
]);
export type AiSecretKind = z.infer<typeof aiSecretKindSchema>;

export const aiSecretScopeSchema = z
  .object({
    type: z.enum(["global", "app", "integration", "ai", "user"]),
    id: z.string().trim().min(1).max(2048).nullable().default(null),
  })
  .strict();
export type AiSecretScope = z.infer<typeof aiSecretScopeSchema>;

interface SecretRow {
  id: string;
  user_id: string;
  kind: string;
  scope_type: string;
  scope_id: string | null;
  ciphertext: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

export interface AiSecretReference {
  secretRef: string;
  kind: AiSecretKind;
  scope: AiSecretScope;
  expiresAt: string;
  stored: true;
}

export function createAiSecretReference(input: {
  actor: AuthenticatedActor;
  kind: AiSecretKind;
  scope: AiSecretScope;
  value: string;
  ttlMs?: number;
}): AiSecretReference {
  if (input.value.length < 1 || Buffer.byteLength(input.value) > 64 * 1024) {
    throw new HttpError(400, "Secure input must be between 1 byte and 64 KiB", "invalid_secret");
  }
  const id = `aisec_${randomToken(18)}`;
  const now = nowIso();
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? aiSecretRefTtlMs())).toISOString();
  getDb()
    .prepare(
      `INSERT INTO ai_secret_refs(
        id, user_id, kind, scope_type, scope_id, ciphertext, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.actor.id,
      input.kind,
      input.scope.type,
      input.scope.id,
      encryptSecret(input.value),
      expiresAt,
      now,
    );
  return {
    secretRef: id,
    kind: input.kind,
    scope: input.scope,
    expiresAt,
    stored: true,
  };
}

export function inspectAiSecretReference(input: {
  secretRef: string;
  actor: AuthenticatedActor;
  kind: AiSecretKind;
  scope: AiSecretScope;
}): AiSecretReference {
  const row = secretRow(input.secretRef);
  assertUsable(row, input);
  return reference(row);
}

export function consumeAiSecretReference(input: {
  secretRef: string;
  actor: AuthenticatedActor;
  kind: AiSecretKind;
  scope: AiSecretScope;
}): string {
  return getDb().transaction(() => {
    const row = secretRow(input.secretRef);
    assertUsable(row, input);
    const plaintext = decryptSecret(row.ciphertext);
    const changed = getDb()
      .prepare("DELETE FROM ai_secret_refs WHERE id = ? AND consumed_at IS NULL AND expires_at > ?")
      .run(row.id, nowIso()).changes;
    if (changed !== 1) {
      throw new HttpError(409, "Secure input is no longer available", "secret_ref_stale");
    }
    return plaintext;
  })();
}

export function deleteAiSecretReference(secretRef: string, actor: AuthenticatedActor): void {
  const changed = getDb()
    .prepare("DELETE FROM ai_secret_refs WHERE id = ? AND user_id = ?")
    .run(secretRef, actor.id).changes;
  if (changed !== 1) throw new HttpError(404, "Secure input not found", "secret_ref_not_found");
}

function secretRow(id: string): SecretRow {
  if (!/^aisec_[A-Za-z0-9_-]{20,}$/.test(id)) {
    throw new HttpError(400, "Invalid secure input reference", "invalid_secret_ref");
  }
  const row = getDb().prepare("SELECT * FROM ai_secret_refs WHERE id = ?").get(id) as
    | SecretRow
    | undefined;
  if (!row) throw new HttpError(409, "Secure input is missing or expired", "secret_ref_stale");
  if (row.consumed_at || Date.parse(row.expires_at) <= Date.now()) {
    getDb().prepare("DELETE FROM ai_secret_refs WHERE id = ?").run(id);
    throw new HttpError(409, "Secure input is missing or expired", "secret_ref_stale");
  }
  return row;
}

function assertUsable(
  row: SecretRow,
  input: {
    actor: AuthenticatedActor;
    kind: AiSecretKind;
    scope: AiSecretScope;
  },
): void {
  const matches =
    row.user_id === input.actor.id &&
    row.kind === input.kind &&
    row.scope_type === input.scope.type &&
    row.scope_id === input.scope.id;
  if (!matches) {
    throw new HttpError(409, "Secure input is missing or expired", "secret_ref_stale");
  }
}

function reference(row: SecretRow): AiSecretReference {
  return {
    secretRef: row.id,
    kind: aiSecretKindSchema.parse(row.kind),
    scope: aiSecretScopeSchema.parse({ type: row.scope_type, id: row.scope_id }),
    expiresAt: row.expires_at,
    stored: true,
  };
}
