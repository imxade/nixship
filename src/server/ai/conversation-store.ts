import crypto from "node:crypto";
import type { AuthenticatedActor } from "../auth.ts";
import { decryptSecret, encryptSecret } from "../crypto.ts";
import { getDb, nowIso } from "../db.ts";
import { HttpError } from "../errors.ts";
import { assertConversationOwner } from "./plans/store.ts";

export type AiMessageRole = "user" | "assistant" | "system";
export type AiMessageKind = "text" | "input_request" | "plan" | "result" | "error";

export interface AiMessage {
  id: string;
  role: AiMessageRole;
  kind: AiMessageKind;
  content: string;
  providerId: string | null;
  modelId: string | null;
  createdAt: string;
}

export interface AiConversation {
  id: string;
  scopeType: "global" | "app" | "deployment" | "integration" | "ai";
  scopeId: string | null;
  title: string | null;
  modelProfileId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function createConversation(
  actor: AuthenticatedActor,
  scope: { type: AiConversation["scopeType"]; id?: string | null } = { type: "global" },
): AiConversation {
  const id = crypto.randomUUID();
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO ai_conversations(id, user_id, scope_type, scope_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'New conversation', ?, ?)`,
    )
    .run(id, actor.id, scope.type, scope.id ?? null, now, now);
  return getConversation(id, actor);
}

export function listConversations(actor: AuthenticatedActor): AiConversation[] {
  return (
    getDb()
      .prepare(
        `SELECT id, scope_type, scope_id, title, model_profile_id, created_at, updated_at
         FROM ai_conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100`,
      )
      .all(actor.id) as Array<{
      id: string;
      scope_type: AiConversation["scopeType"];
      scope_id: string | null;
      title: string | null;
      model_profile_id: string | null;
      created_at: string;
      updated_at: string;
    }>
  ).map((row) => ({
    id: row.id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    title: row.title,
    modelProfileId: row.model_profile_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function getConversation(id: string, actor: AuthenticatedActor): AiConversation {
  const row = getDb()
    .prepare(
      `SELECT id, scope_type, scope_id, title, model_profile_id, created_at, updated_at
       FROM ai_conversations WHERE id = ? AND user_id = ?`,
    )
    .get(id, actor.id) as
    | {
        id: string;
        scope_type: AiConversation["scopeType"];
        scope_id: string | null;
        title: string | null;
        model_profile_id: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (!row) throw new HttpError(404, "AI conversation not found", "conversation_not_found");
  return {
    id: row.id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    title: row.title,
    modelProfileId: row.model_profile_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function setConversationModel(
  id: string,
  actor: AuthenticatedActor,
  modelProfileId: string | null,
): AiConversation {
  assertConversationOwner(id, actor.id);
  if (modelProfileId) {
    const profile = getDb()
      .prepare(
        `SELECT 1
         FROM ai_model_profiles p
         JOIN ai_provider_configs c ON c.id = p.provider_config_id
         WHERE p.id = ? AND p.answer_capable = 1 AND c.enabled = 1`,
      )
      .get(modelProfileId);
    if (!profile) {
      throw new HttpError(
        409,
        "The selected model is unavailable or has not passed the chat probe",
        "ai_model_not_chat_ready",
      );
    }
  }
  getDb()
    .prepare("UPDATE ai_conversations SET model_profile_id = ?, updated_at = ? WHERE id = ?")
    .run(modelProfileId, nowIso(), id);
  return getConversation(id, actor);
}

export function listMessages(id: string, actor: AuthenticatedActor, limit = 50): AiMessage[] {
  assertConversationOwner(id, actor.id);
  const rows = getDb()
    .prepare(
      `SELECT * FROM (
        SELECT id, role, kind, content_ciphertext, provider_id, model_id, created_at
        FROM ai_messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?
      ) ORDER BY created_at`,
    )
    .all(id, Math.min(100, Math.max(1, limit))) as Array<{
    id: string;
    role: AiMessageRole;
    kind: AiMessageKind;
    content_ciphertext: string;
    provider_id: string | null;
    model_id: string | null;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    kind: row.kind,
    content: decryptSecret(row.content_ciphertext),
    providerId: row.provider_id,
    modelId: row.model_id,
    createdAt: row.created_at,
  }));
}

export function addMessage(input: {
  conversationId: string;
  actor: AuthenticatedActor;
  role: AiMessageRole;
  kind: AiMessageKind;
  content: string;
  providerId?: string | null;
  modelId?: string | null;
}): AiMessage {
  assertConversationOwner(input.conversationId, input.actor.id);
  if (Buffer.byteLength(input.content) > 64 * 1024) {
    throw new HttpError(413, "AI message is too large", "message_too_large");
  }
  const id = crypto.randomUUID();
  const now = nowIso();
  getDb().transaction(() => {
    getDb()
      .prepare(
        `INSERT INTO ai_messages(
          id, conversation_id, role, kind, content_ciphertext, provider_id, model_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.conversationId,
        input.role,
        input.kind,
        encryptSecret(input.content),
        input.providerId ?? null,
        input.modelId ?? null,
        now,
      );
    getDb()
      .prepare("UPDATE ai_conversations SET updated_at = ? WHERE id = ?")
      .run(now, input.conversationId);
  })();
  return {
    id,
    role: input.role,
    kind: input.kind,
    content: input.content,
    providerId: input.providerId ?? null,
    modelId: input.modelId ?? null,
    createdAt: now,
  };
}

export function deleteConversation(id: string, actor: AuthenticatedActor): void {
  const changed = getDb()
    .prepare("DELETE FROM ai_conversations WHERE id = ? AND user_id = ?")
    .run(id, actor.id).changes;
  if (changed !== 1)
    throw new HttpError(404, "AI conversation not found", "conversation_not_found");
}

export function assertChatTextSafe(text: string): void {
  if (Buffer.byteLength(text) > 16 * 1024) {
    throw new HttpError(413, "Chat input is too large", "message_too_large");
  }
  const credentialPatterns = [
    /\b(?:password|passwd|api[_ -]?key|token|secret)\s*[:=]\s*\S+/i,
    /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  ];
  if (credentialPatterns.some((pattern) => pattern.test(text))) {
    throw new HttpError(
      400,
      "Do not paste credentials into chat. Use a dedicated secure input card.",
      "credential_in_chat",
    );
  }
}
